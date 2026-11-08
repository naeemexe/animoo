// Motion for each beat: Kimodo on the pod (through gpu/tunnel.sh →
// localhost:8101), cached in the browser per prompt, with library/motions/ as
// the fallback when the server is down.
import { LIBRARY_BASE, loadManifest } from '../library.js';
import { API_BASE, urlParams } from '../api.js';

export const MOTION_URL = urlParams.get('motion') ?? 'http://localhost:8101';
const CACHE_NAME = 'animo-motion-v1';
const memory = new Map();

// The browser cache key: every input that changes Kimodo's output.
const keyFor = ({ prompt, duration, seed = 0 }) =>
  `https://animo.cache/motion?${new URLSearchParams({ prompt, duration: duration.toFixed(2), seed, post: 1 })}`;

async function cacheGet(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const hit = await (await caches.open(CACHE_NAME)).match(key);
    if (hit) { const text = await hit.text(); memory.set(key, text); return text; }
  } catch { /* no Cache Storage (file://, private mode): memory only */ }
  return null;
}
async function cachePut(key, text) {
  memory.set(key, text);
  try { await (await caches.open(CACHE_NAME)).put(key, new Response(text, { headers: { 'Content-Type': 'text/plain' } })); } catch { /* memory only */ }
}

export async function clearMotionCache() {
  memory.clear();
  try { await caches.delete(CACHE_NAME); } catch { /* ignore */ }
}

let healthPromise = null;
// Is the motion server reachable? Asked once per page load (and again after a failure).
export function motionServerUp() {
  healthPromise ??= fetch(`${MOTION_URL}/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok).catch(() => false);
  return healthPromise;
}

// A library motion for a prompt, by keyword. Used only when Kimodo is down.
const FALLBACK_WORDS = [
  [/\b(sit|sits|seated|rest)/, 'persona_idle'],
  [/\b(wave|waves|waving|hello)/, 'persona_wave'],
  [/\b(run|runs|jog|sneak)/, 'sneak_forward'],
  [/\b(walk|walks|stroll|steps?)/, 'walk_forward'],
  [/\b(dance|dances)/, 'silly_dance'],
  [/\b(talk|talks|speaks|says)/, 'talking'],
  [/\b(jump|jumps)/, 'sneak_jump'],
  [/\b(kick)/, 'spinning_kick'],
  [/\b(flip)/, 'backflip'],
];
export async function fallbackFor(prompt) {
  const p = prompt.toLowerCase();
  const name = FALLBACK_WORDS.find(([re]) => re.test(p))?.[1] ?? 'persona_idle';
  const m = await loadManifest();
  const entry = m.motions.find((x) => x.file === `motions/${name}.bvh`);
  return entry?.file ?? 'motions/persona_idle.bvh';
}

// → { text, source: 'browser cache' | 'kimodo' | 'kimodo cache' | 'library', ms, file? }
export async function motionFor({ prompt, duration, seed = 0 }) {
  const t0 = performance.now();
  const key = keyFor({ prompt, duration, seed });
  const cached = await cacheGet(key);
  if (cached) return { text: cached, source: 'browser cache', ms: performance.now() - t0 };

  if (await motionServerUp()) {
    try {
      const res = await fetch(`${MOTION_URL}/generate-motion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, duration, post_processing: true, seed }),
        signal: AbortSignal.timeout(180000), // requests queue on the pod
      });
      if (!res.ok) throw new Error(`generate-motion returned ${res.status}`);
      const text = await res.text();
      await cachePut(key, text);
      const source = res.headers.get('X-Cache') === 'hit' ? 'kimodo cache' : 'kimodo';
      return { text, source, ms: performance.now() - t0 };
    } catch (err) {
      console.warn(`Kimodo failed for "${prompt}", using the library:`, err.message);
      healthPromise = null;
    }
  }
  const file = await fallbackFor(prompt);
  const res = await fetch(LIBRARY_BASE + file);
  if (!res.ok) throw new Error(`${file} returned ${res.status}`);
  return { text: await res.text(), source: 'library', file, ms: performance.now() - t0 };
}

// ---- the action library (task 22) ---------------------------------------------
// Standard clips generated once with Kimodo (server/tools/actions.py), cached in
// library/motions/actions/ with their prompts. Script beats carry `motion`, an id.
// Locomotion picks a length variant by distance; seated and in-place clips get a
// filler (seated idle, or themselves looped) when the beat runs longer.
export const VARIANTS = {
  walk: ['walk_steps', 'walk_short', 'walk', 'walk_long'],
  run: ['run', 'run_long'],
  crouch_walk: ['crouch_walk'],
};
export const FILLER = { sit_bench: 'sit_bench_idle', sit_ground: 'sit_ground_idle', stand_up_chair: 'idle', stand_up_ground: 'idle' };

let actionsPromise = null;
export function loadActions() {
  actionsPromise ??= fetch(`${LIBRARY_BASE}motions/actions/index.json`)
    .then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return actionsPromise;
}
const texts = new Map();
const actionText = (file) => {
  if (!texts.has(file)) texts.set(file, fetch(LIBRARY_BASE + file).then((r) => {
    if (!r.ok) throw new Error(`${file} returned ${r.status}`);
    return r.text();
  }));
  return texts.get(file);
};

// → { action, variants: [{ meta, text }], filler: { meta, text } | null, source, ms } or null (not in the library)
export async function actionFor(beat) {
  const t0 = performance.now();
  const index = await loadActions();
  const ids = (VARIANTS[beat.motion] ?? [beat.motion]).filter((id) => index[id]);
  if (!ids.length) return null;
  const variants = await Promise.all(ids.map(async (id) => ({ meta: index[id], text: await actionText(index[id].file) })));
  const fid = FILLER[beat.motion] ?? (index[beat.motion]?.root === 'pinned' ? beat.motion : null);
  const filler = fid && index[fid] ? { meta: index[fid], text: await actionText(index[fid].file) } : null;
  return { action: beat.motion, variants, filler, source: 'action library', ms: performance.now() - t0 };
}

// A move outside the library, through the app server (POST /api/motion), which
// asks Kimodo once and keeps it in library/motions/live/. → { text, source, ms } or null
export async function liveFor({ prompt, duration, seed = 0 }) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${API_BASE}/api/motion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, duration, seed }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return { text, source: res.headers.get('X-Cache') === 'hit' ? 'live, cached in library' : 'kimodo live', ms: performance.now() - t0 };
  } catch { return null; }
}

// Background extras (task 36): no LLM call. In city, park, beach and restaurant sets
// 4–8 people go about their day on loops from the action library: strolling
// round the square, sitting on free benches or the grass, chatting in pairs,
// someone waiting, diners at the other tables. Only the calm clips (CALM) are
// used: big gestures (hammering with no hammer, stretching, laughing, digging)
// read as broken arms or dancing from afar. They keep well away from
// every spot the cast passes through (sampled from the merged clips), from
// the props and the fill (trees, lamps, buildings), so they stay out of the
// action, out of the camera's focus and out of everyone's paths.
//
// Cheap: one unposed base VRM per gender is loaded once; every extra is a
// clone of it (shared textures and geometry; a build gets its own geometry),
// with a fresh humanoid rig, no spring bones and no leg IK. Their clips are
// retargeted once on the base. `?npcs=0` (or script.npcs === false) turns
// them off.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { VRMHumanoid } from '@pixiv/three-vrm';
import { loadCharacter, applyLook, Character } from '../characters/index.js';
import { mulberry32 } from '../stage.js';
import { actionFor } from './clips.js';
import { loadProp } from '../library.js';
import { seaSide } from './fill.js';
import { prepareAction, loopTo, warpToPath, obstaclesFromSet, seatsFromSet } from './control.js';

const BIOMES = new Set(['city', 'park', 'restaurant', 'sea']);
// The only clips an extra plays: stand, talk, sit, walk. Never live Kimodo.
const CALM = new Set(['idle', 'talk', 'walk', 'sit_bench_idle', 'sit_bench_talk', 'sit_ground_idle']);
const MAX = 8;
// The base VRMs' natural heights → adult heights (server/agents/movie.py HEIGHT).
const ADULT = { avatar_male: 1.76 / 2.01, avatar_female: 1.70 / 1.54 };

// Start loading the base figures early (with the cast), if this set gets extras.
export function preloadExtras(script, params) {
  if (!npcsWanted(script, params)) return;
  base('avatar_male').catch(() => {});
  base('avatar_female').catch(() => {});
}

export function npcsWanted(script, params) {
  if (params.get('npcs') === '0' || script?.npcs === false) return false;
  return BIOMES.has(script?.terrain?.biome);
}

// ---- figures ------------------------------------------------------------------

const bases = new Map(); // character id → Promise<{ hero, vrm }>
function base(id) {
  if (!bases.has(id)) bases.set(id, loadCharacter(id).then((hero) => ({ hero, vrm: hero.vrm })));
  return bases.get(id);
}

// A copy of an unposed VRM: its own bones and humanoid rig, shared textures.
function cloneVRM(vrm, { ownGeometry = false } = {}) {
  const src = vrm.scene;
  const rigIndex = src.children.indexOf(vrm.humanoid.normalizedHumanBonesRoot);
  const scene = SkeletonUtils.clone(src);
  const map = new Map();
  (function walk(a, b) { map.set(a, b); a.children.forEach((c, i) => walk(c, b.children[i])); })(src, scene);
  if (rigIndex >= 0) scene.remove(scene.children[rigIndex]);
  const mats = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const one = (m) => { if (!mats.has(m)) mats.set(m, m.clone()); return mats.get(m); };
    o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    if (ownGeometry && o.isSkinnedMesh) o.geometry = o.geometry.clone();
  });
  const humanBones = {};
  for (const [name, bone] of Object.entries(vrm.humanoid.humanBones)) {
    if (bone?.node && map.has(bone.node)) humanBones[name] = { node: map.get(bone.node) };
  }
  // The normalized rig is measured in the VRM's own frame, as at load (before rotateVRM0).
  // By quaternion: the clone's Euler for the VRM 0 half turn comes out as (-π, 0, -π),
  // so zeroing rotation.y left it turned and every extra's arms bent the wrong way.
  const q = scene.quaternion.clone();
  scene.quaternion.identity();
  scene.updateMatrixWorld(true);
  const humanoid = new VRMHumanoid(humanBones);
  scene.quaternion.copy(q);
  scene.add(humanoid.normalizedHumanBonesRoot);
  scene.updateMatrixWorld(true);
  return { scene, humanoid, meta: vrm.meta, update() { humanoid.update(); } };
}

async function figure(character, look) {
  const b = await base(character);
  const vrm = cloneVRM(b.vrm, { ownGeometry: !!(look.build && look.build !== 'average') || look.outfit === 'winter_coat' });
  const npc = new Character(vrm, b.hero.retargeter, { name: 'extra' });
  npc.ik = false;
  applyLook(npc, look);
  vrm.scene.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return npc;
}

// ---- looks --------------------------------------------------------------------

const TOPS = ['#c8352e', '#2f5fb0', '#e0a93a', '#3f8a45', '#7a4a9a', '#e8e2d6', '#d06a8a', '#3a7f8f', '#8a5a3a'];
const BOTTOMS = ['#23305e', '#b5a46e', '#47648f', '#3a3a40', '#6a4a3a', '#8a8a8f'];
const HAIR = ['#5a3a22', '#2a1e18', '#e0c070', '#9a9a9a', '#8a3a22', '#3a2a1e'];
const SKIN = ['#efc9ab', '#e2b48f', '#c48a5e', '#8d5a3a', '#f3d6c0'];
const pick = (rng, a) => a[Math.floor(rng() * a.length) % a.length];

function lookFor(rng, kind, female, weather) {
  const outfit = kind === 'worker' ? 'worker' : kind === 'chef' ? 'chef'
    : weather === 'snow' && rng() < 0.6 ? 'winter_coat'
    : female && rng() < 0.3 ? 'dress' : !female && rng() < 0.2 ? 'suit' : 'casual';
  const build = pick(rng, ['slim', 'average', 'average', 'sturdy', 'heavy']);
  const look = { outfit, build, top: pick(rng, TOPS), bottom: pick(rng, BOTTOMS), hair: pick(rng, HAIR), skin: pick(rng, SKIN) };
  if (outfit === 'worker') delete look.top;
  if (kind === 'stroll' && rng() < 0.25) look.accessory = female ? 'hat' : 'cap';
  return look;
}

// ---- where the action is --------------------------------------------------------

// Every spot the cast's hips pass through (every 0.25 s), in world space.
function castPoints(rows, heroes) {
  const pts = [];
  for (const [id, row] of Object.entries(rows)) {
    const clip = row.clip, k = heroes[id]?.group.scale.x ?? 1;
    if (!clip) continue;
    const step = Math.max(1, Math.round(clip.fps / 4));
    for (let f = 0; f < clip.frames; f += step) pts.push([clip.hips[f * 3] * k, clip.hips[f * 3 + 2] * k]);
  }
  return pts;
}

// Discs [x, z, r] for what the fill put down (trees, lamps, hedges, cars, buildings, bushes).
function fillDiscs(set) {
  const out = [];
  const fill = set.children.find((c) => c.name === 'fill');
  if (!fill) return out;
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (const g of fill.children) {
    if (/grass|flower|tuft|rocks$/.test(g.name)) continue;
    let im = null;
    g.traverse((o) => { if (!im && o.isInstancedMesh) im = o; });
    if (!im) continue;
    im.geometry.computeBoundingSphere();
    const r0 = im.geometry.boundingSphere.radius;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      m.decompose(p, q, s);
      out.push([p.x, p.z, THREE.MathUtils.clamp(r0 * s.x * 0.55, 0.5, 8)]);
    }
  }
  return out;
}

function boxDist(o, x, z) {
  const dx = x - o.c[0], dz = z - o.c[1];
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const lx = Math.abs(c * dx - s * dz) - o.h[0], lz = Math.abs(s * dx + c * dz) - o.h[1];
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
}

// ---- the extras -----------------------------------------------------------------

// → { group, list, update(t), duration } or null. `rows`/`heroes` are the cast's.
export async function addExtras(stage, script, set, rows, heroes, duration, { seed = 36 } = {}) {
  const biome = script.terrain?.biome;
  if (!BIOMES.has(biome)) return null;
  const rng = mulberry32(seed + script.beats.length * 7 + script.props.length);
  const busy = castPoints(rows, heroes);
  const obstacles = obstaclesFromSet(set);
  const discs = fillDiscs(set);
  const weather = script.terrain?.weather;
  const center = busy.length
    ? busy.reduce((a, p) => [a[0] + p[0] / busy.length, a[1] + p[1] / busy.length], [0, 0]) : [0, 0];
  const indoor = biome === 'restaurant';
  const awayFromCast = indoor ? 1.6 : 5;
  const sea = biome === 'sea' ? seaSide(script) : null;
  const free = (x, z, { away = awayFromCast, body = 0.5, props = true } = {}) =>
    !(sea && sea.wet(x, z, 1.5))
    && busy.every((p) => Math.hypot(x - p[0], z - p[1]) >= away)
    && (!props || obstacles.every((o) => boxDist(o, x, z) >= body))
    && discs.every(([cx, cz, r]) => Math.hypot(x - cx, z - cz) >= r + body * 0.6)
    && taken.every(([a, b, r]) => Math.hypot(x - a, z - b) >= r);
  const taken = []; // [x, z, r] already used by extras
  const D = duration + 4;
  const plans = []; // { kind, female, action, at, facing, path?, phase }
  let furnitureJobs = []; // tables and chairs the extras bring (restaurant)

  // A spot for one or two standing extras, at a radius band around the action.
  const spot = (r0, r1, opts) => {
    for (let k = 0; k < 60; k++) {
      const a = rng() * Math.PI * 2, r = r0 + rng() * (r1 - r0);
      const x = center[0] + Math.sin(a) * r, z = center[1] + Math.cos(a) * r;
      if (free(x, z, opts)) return [x, z];
    }
    return null;
  };
  // An arc around the action that a walker of `len` metres can follow, clear all the way.
  const arc = (len, r0, r1) => {
    for (let k = 0; k < 120; k++) {
      const R = r0 + rng() * (r1 - r0), a0 = rng() * Math.PI * 2, dir = rng() < 0.5 ? 1 : -1;
      const sweep = len / R, n = Math.max(8, Math.ceil(len / 1.2));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + dir * sweep * (i / n);
        pts.push([center[0] + Math.sin(a) * R, center[1] + Math.cos(a) * R]);
      }
      if (sweep < Math.PI * 1.6 && pts.every(([x, z]) => free(x, z, { away: 4, body: 0.3 }))) return pts;
    }
    return null;
  };
  const face = (from, to) => Math.atan2(to[0] - from[0], to[1] - from[1]);

  if (indoor) {
    // Diners at the fill's other tables (two chairs each), a chef by the counter.
    const fill = set.children.find((c) => c.name === 'fill');
    const chairs = (fill?.children ?? []).filter((o) => o.userData.prop?.id === 'chair');
    const byTable = [];
    for (const ch of chairs) {
      const r = ch.rotation.y, front = [Math.sin(r), Math.cos(r)];
      const at = [ch.position.x - front[0] * 0.07, ch.position.z - front[1] * 0.07];
      if (!busy.every((p) => Math.hypot(at[0] - p[0], at[1] - p[1]) >= awayFromCast)) continue;
      const mate = byTable.find((t) => t.length === 1 && Math.hypot(t[0].at[0] - at[0], t[0].at[1] - at[1]) < 1.6);
      if (mate) mate.push({ at, facing: r }); else byTable.push([{ at, facing: r }]);
    }
    // A small room leaves the fill few free tables: lay up to two more, clear of the
    // furniture, the walls and the cast (they belong to the extras: ?npcs=0 removes them too).
    const R = fill?.userData.room;
    const furniture = obstaclesFromSet(fill ?? new THREE.Group());
    const clear = (x, z, r) => busy.every((p) => Math.hypot(x - p[0], z - p[1]) >= r + 1.2)
      && [...obstacles, ...furniture].every((o) => boxDist(o, x, z) >= r)
      && byTable.every((t) => Math.hypot(x - t[0].at[0], z - t[0].at[1]) >= r + 1.6);
    const laid = [];
    for (let k = 0; R && k < 200 && byTable.filter((t) => t.length === 2).length < 3; k++) {
      const x = R.x0 + 1.6 + rng() * (R.x1 - R.x0 - 3.2), z = R.z0 + 1.6 + rng() * (R.z1 - R.z0 - 3.2);
      if (!clear(x, z, 1.2)) continue;
      const a = rng() < 0.5 ? 0 : Math.PI / 2;
      laid.push(['dining-table', x, z, 0]);
      const pair = [];
      for (const sgn of [1, -1]) {
        const cx = x + Math.sin(a) * sgn * 0.72, cz = z + Math.cos(a) * sgn * 0.72, r = a + (sgn > 0 ? Math.PI : 0);
        laid.push(['chair', cx, cz, r]);
        pair.push({ at: [cx - Math.sin(r) * 0.07, cz - Math.cos(r) * 0.07], facing: r });
      }
      byTable.push(pair);
    }
    furnitureJobs = laid.map(([id, x, z, rot]) => loadProp(id).then((o) => { o.position.set(x, 0, z); o.rotation.y = rot; return o; }));
    byTable.sort((a, b) => Math.hypot(b[0].at[0] - center[0], b[0].at[1] - center[1]) - Math.hypot(a[0].at[0] - center[0], a[0].at[1] - center[1]));
    for (const t of byTable.slice(0, 3)) {
      t.forEach((s, i) => plans.push({ kind: 'diner', female: rng() < 0.5, action: i === 0 ? 'sit_bench_talk' : 'sit_bench_idle', at: s.at, facing: s.facing }));
    }
    const counter = (fill?.children ?? []).find((o) => o.userData.prop?.id === 'counter');
    if (counter && plans.length < MAX) {
      const r = counter.rotation.y, at = [counter.position.x + Math.sin(r) * 1.0, counter.position.z + Math.cos(r) * 1.0];
      if (free(at[0], at[1], { body: 0.3 })) plans.push({ kind: 'chef', female: rng() < 0.5, action: 'idle', at, facing: r });
    }
  } else {
    // Strollers (and a jogger in the park) on arcs round the square.
    const walkers = biome === 'park' ? [['walk', 1.25], ['walk', 1.25], ['walk', 1.25]] : [['walk', 1.25], ['walk', 1.25]];
    for (const [action, speed] of walkers) {
      const len = Math.min(speed * D, 40);
      const pts = arc(len, 8, 20);
      if (!pts) continue;
      for (const p of pts) taken.push([p[0], p[1], 1.0]);
      plans.push({ kind: 'stroll', female: rng() < 0.5, action, path: pts });
    }
    // Free benches far from the cast: one sitter each (at most two).
    let benches = 0;
    for (const s of seatsFromSet(set)) {
      if (benches >= 2 || !/bench/.test(s.key)) continue;
      const at = [s.c[0] + s.front[0] * s.back, s.c[1] + s.front[1] * s.back];
      if (!free(at[0], at[1], { body: 0, props: false })) continue;
      taken.push([at[0], at[1], 1.5]);
      plans.push({ kind: 'sitter', female: rng() < 0.5, action: rng() < 0.5 ? 'sit_bench_idle' : 'sit_bench_talk', at, facing: Math.atan2(s.front[0], s.front[1]) });
      benches++;
    }
    // A chatting pair; in the park a second pair sits on the grass.
    const pairs = biome === 'park' || biome === 'sea' ? [['talk', 'idle'], ['sit_ground_idle', 'sit_ground_idle']] : [['talk', 'idle']];
    for (const [a1, a2] of pairs) {
      const c = spot(7, 14, { body: 1.0 });
      if (!c) continue;
      const ang = rng() * Math.PI * 2, h = a1.startsWith('sit') ? 0.55 : 0.6;
      const p1 = [c[0] + Math.sin(ang) * h, c[1] + Math.cos(ang) * h], p2 = [c[0] - Math.sin(ang) * h, c[1] - Math.cos(ang) * h];
      taken.push([c[0], c[1], 2.0]);
      plans.push({ kind: 'chat', female: rng() < 0.5, action: a1, at: p1, facing: face(p1, p2) });
      plans.push({ kind: 'chat', female: rng() < 0.5, action: a2, at: p2, facing: face(p2, p1) });
    }
    // Someone standing and waiting (for a bus, a friend), turned a little away from the action.
    const solo = { kind: 'solo', female: rng() < 0.5, action: 'idle' };
    const c = spot(8, 15, { body: 0.8 });
    if (c) { taken.push([c[0], c[1], 1.5]); plans.push({ ...solo, at: c, facing: face(center, c) + (rng() - 0.5) }); }
  }

  // Clips: each action prepared once per gender, then looped/warped per extra.
  const prepared = new Map();
  const clipFor = async (character, action) => {
    const key = `${character}:${action}`;
    if (!prepared.has(key)) {
      prepared.set(key, (async () => {
        const b = await base(character);
        const m = await actionFor({ motion: action });
        if (!m) return null;
        const beat = { id: `extra-${action}`, motion: action, duration: 4 };
        return prepareAction((text, name) => b.hero.makeClip(text, name), beat, m);
      })());
    }
    return prepared.get(key);
  };

  const group = new THREE.Group();
  group.name = 'extras';
  for (const o of await Promise.all(furnitureJobs.map((j) => j.catch(() => null)))) if (o) group.add(o);
  const list = [];
  await Promise.all(plans.filter((p) => CALM.has(p.action)).slice(0, MAX).map(async (p, i) => {
    const character = p.female ? 'avatar_female' : 'avatar_male';
    const entry = await clipFor(character, p.action).catch((err) => { console.warn('extra clip:', err.message); return null; });
    if (!entry) return;
    const phase = rng() * 4;
    // Adult heights like the cast's (server HEIGHT: 1.76 m men, 1.70 m women), ±4 %.
    const k = (ADULT[character] ?? 1) * (0.96 + rng() * 0.08);
    let clip;
    if (p.path) {
      // Long enough for the whole film, then bent onto its arc (stride fits the arc).
      // The clip is in the figure's own (scaled) space, like the cast's.
      const src = entry.variants[entry.variants.length - 1];
      clip = warpToPath(loopTo(src, D + phase, src, { blend: 0.4 }), p.path.map(([x, z]) => [x / k, z / k]));
    } else {
      clip = loopTo(entry.clip, D + phase, entry.clip, { blend: 0.5 }).clone().normalizeStart();
    }
    const npc = await figure(character, lookFor(rng, p.kind, p.female, weather));
    npc.clip = clip;
    npc.group.name = `extra-${i + 1}`;
    npc.group.scale.setScalar(k);
    if (!p.path) {
      npc.group.position.set(p.at[0], 0, p.at[1]);
      npc.group.rotation.y = p.facing;
    }
    npc.phase = phase;
    npc.plan = p;
    group.add(npc.group);
    list.push(npc);
  }));
  stage.scene.add(group);
  return {
    group,
    list,
    summary: summarize(list),
    update(t) {
      for (const npc of list) {
        npc.time = Math.min(t + npc.phase, npc.duration);
        npc.apply();
        npc.vrm.update();
      }
    },
    dispose() { stage.scene.remove(group); },
  };
}

function summarize(list) {
  const n = (k) => list.filter((x) => x.plan.kind === k).length;
  const parts = [
    [n('stroll'), 'on a stroll'], [n('sitter'), 'on benches'], [n('chat'), 'chatting'],
    [n('solo'), 'waiting'], [n('diner'), 'dining'], [n('chef'), 'by the counter'],
  ].filter(([k]) => k).map(([k, w]) => `${k} ${w}`);
  return `${list.length} extras: ${parts.join(', ')}`;
}

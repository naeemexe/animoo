// Characters: load a library VRM and play Kimodo clips on it.
//
//   const hero = await loadCharacter('avatar_male');
//   scene.add(hero.group);
//   hero.setClips([hero.makeClip(walkBvh, 'walk'), hero.makeClip(waveBvh, 'wave')]);
//   // every frame: hero.update(dt)
import { LIBRARY_BASE } from '../library.js';
import { parseBVH } from './bvh.js';
import { loadVRM } from './vrm.js';
import { createRetargeter } from './retarget.js';
import { Character } from './player.js';

export { parseBVH } from './bvh.js';
export { mergeClips, mergeAll, plantFeet } from './merge.js';
export { Character } from './player.js';
export { applyLook } from './look.js';

// A standing Kimodo frame that both rigs' bone frames are measured on. Every
// Kimodo clip shares this skeleton, so one reference serves all of them.
const REFERENCE_BVH = 'motions/persona_idle.bvh';
let referencePromise = null;
function reference() {
  referencePromise ??= fetchBVH(REFERENCE_BVH);
  return referencePromise;
}

export async function fetchBVH(path) {
  const url = /^(https?:)?\//.test(path) ? path : LIBRARY_BASE + path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return parseBVH(await res.text());
}

export async function loadCharacter(id) {
  const [vrm, ref] = await Promise.all([loadVRM(`${LIBRARY_BASE}characters/${id}.vrm`), reference()]);
  return new Character(vrm, createRetargeter(vrm, ref), { name: id });
}

// Live clips from the Kimodo server (through gpu/tunnel.sh → localhost:8101).
export async function generateMotion(prompt, { duration = 5, seed = 0, url = 'http://localhost:8101' } = {}) {
  const res = await fetch(`${url}/generate-motion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, duration, post_processing: true, seed }),
  });
  if (!res.ok) throw new Error(`generate-motion returned ${res.status}`);
  return parseBVH(await res.text());
}

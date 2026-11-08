// A cast member's look (task 27): the plan picks clothing, hair and skin
// colors and maybe one accessory; this recolors the VRM's MToon materials and
// puts the accessory on the head (or the chest, for an apron).
//
//   applyLook(hero, { top: '#c8352e', bottom: '#23305e', hair: '#e0c070', skin: '#efc9ab', accessory: 'cap' })
//
// A cast without a look is left exactly as loaded (old cached scripts).
//
// Task 35 adds game-style skins on the same rig: `outfit` (casual, dress,
// suit, chef, worker, winter_coat) is a color/pattern set for the clothing
// materials plus its small extras (a tie, a scarf, a hard hat), and `build`
// (slim, average, sturdy, heavy) widens the body (build.js). Look colors the
// plan gives win over the outfit's, except where the outfit fixes them.
import * as THREE from 'three';
import { applyBuild } from './build.js';

// Outfit presets: default slot colors, colors it fixes, a pattern on a slot,
// a default accessory, extras that always come with it, and coat bulk (m).
export const OUTFITS = {
  casual: { top: '#3f8a45', bottom: '#47648f', shoes: '#f2f0ea' },
  dress: { top: '#b23a5a', shoes: '#3a2a2a', same: ['bottom', 'top'], pattern: { slot: 'top', kind: 'dots', color: '#f2f0ea' } },
  suit: { top: '#33343c', bottom: '#33343c', shoes: '#1a1a1e', same: ['bottom', 'top'], extras: ['tie'],
    pattern: { slot: 'top', kind: 'pinstripe', color: '#55565f' } },
  chef: { fixed: { top: '#f4f2ec', bottom: '#eeeeea' }, shoes: '#22222a', accessory: 'chef_hat',
    pattern: { slot: 'bottom', kind: 'check', color: '#2a2a30' } },
  worker: { top: '#e8762a', bottom: '#47648f', shoes: '#6a4428', accessory: 'hard_hat',
    pattern: { slot: 'top', kind: 'bands', color: '#e8e2a0' } },
  winter_coat: { top: '#8a2f2f', bottom: '#33343c', shoes: '#4a3022', extras: ['scarf'], bulk: 0.018 },
};

// Resolve a look with an outfit into plain slot colors + extras.
export function resolveLook(look) {
  const o = OUTFITS[look.outfit];
  if (!o) return { ...look, extras: [] };
  const r = { ...look };
  for (const k of ['top', 'bottom', 'shoes']) r[k] = o.fixed?.[k] ?? look[k] ?? o[k];
  if (o.same) r[o.same[0]] = r[o.same[1]];
  r.accessory = look.accessory || o.accessory;
  return { ...r, extras: o.extras ?? [], pattern: o.pattern, bulk: o.bulk };
}

// VRoid material names → look slot.
const SLOTS = [
  [/_Tops_/i, 'top'],
  [/_Bottoms_/i, 'bottom'],
  [/_Shoes_/i, 'shoes'],
  [/_HAIR/i, 'hair'],
  [/_(Face|Body)_\d+_SKIN/i, 'skin'],
];
// Extra VRoid accessories baked into a model; with a look they only show when asked for.
const BAKED = [[/Glasses/i, 'glasses'], [/CatEar|FoxTail/i, null]];

// The material's texture as gray (detail kept, color dropped), scaled so its
// mean is `mean`: multiplied by the new color it reads as that color.
function grayTexture(tex, mean, pattern = null, base = null) {
  const img = tex?.image;
  if (!img?.width) return null;
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, cv.width, cv.height);
  const px = data.data;
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 16) continue;
    sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    n++;
  }
  const k = n ? (mean * 255) / (sum / n) : 1;
  // With a pattern the colors are baked in (base where the pattern is off,
  // pattern color where on) and the material color goes white.
  const W = cv.width, pc = pattern && new THREE.Color(pattern.color), bc = pattern && new THREE.Color(base);
  const P = pattern && PATTERNS[pattern.kind];
  for (let i = 0; i < px.length; i += 4) {
    const y = Math.min(255, (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * k);
    if (!P) { px[i] = px[i + 1] = px[i + 2] = y; continue; }
    const n = i / 4, on = P((n % W) / W, Math.floor(n / W) / cv.height);
    const c = on ? pc : bc;
    px[i] = Math.min(255, y * c.r * 1.08); px[i + 1] = Math.min(255, y * c.g * 1.08); px[i + 2] = Math.min(255, y * c.b * 1.08);
  }
  g.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(cv);
  out.colorSpace = tex.colorSpace;
  out.flipY = tex.flipY;
  out.wrapS = tex.wrapS; out.wrapT = tex.wrapT;
  out.channel = tex.channel;
  return out;
}

// Patterns in the texture's UV space (u, v in 0…1) → on/off.
const PATTERNS = {
  dots: (u, v) => { const a = (u * 40) % 1 - 0.5, b = (v * 40) % 1 - 0.5; return a * a + b * b < 0.06; },
  pinstripe: (u) => (u * 90) % 1 < 0.08,
  check: (u, v) => (Math.floor(u * 48) + Math.floor(v * 48)) % 2 === 0,
  bands: (u, v) => { const x = (v * 6) % 1; return x > 0.42 && x < 0.52; },
};

function recolor(mat, hex, pattern = null) {
  const c = new THREE.Color(hex);
  let baked = false;
  if (mat.map) {
    const gray = grayTexture(mat.map, 0.9, pattern, hex);
    if (gray) { mat.map = gray; baked = !!pattern; }
  }
  if (mat.shadeMultiplyTexture) mat.shadeMultiplyTexture = mat.map;
  mat.color?.copy(baked ? new THREE.Color(1, 1, 1) : c);
  // Shade a little darker and cooler than the lit color, like VRoid's defaults.
  mat.shadeColorFactor?.copy(c).multiplyScalar(0.72).lerp(new THREE.Color('#6a5a7a'), 0.12);
  mat.needsUpdate = true;
}

function headFrame(vrm) {
  const head = vrm.humanoid.getRawBoneNode('head');
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const at = head.getWorldPosition(new THREE.Vector3());
  const y = (b) => vrm.humanoid.getRawBoneNode(b)?.getWorldPosition(new THREE.Vector3()).y;
  return { head, at, top: box.max.y - at.y, height: box.max.y - box.min.y, neckY: y('neck'), hipsY: y('hips') };
}

const MAT = (color, rough = 0.8) => new THREE.MeshStandardMaterial({ color, roughness: rough });

function makeAccessory(kind, look, f) {
  const r = f.top * 0.62; // head radius, from the head bone to the crown
  const g = new THREE.Group();
  const shade = look.top || '#5a4636';
  if (kind === 'hat') {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.9, r * 1.9, r * 0.08, 28), MAT(shade));
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 1.05, r * 0.95, 24), MAT(shade));
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.07, r * 1.07, r * 0.2, 24), MAT('#2a2324'));
    crown.position.y = r * 0.5; band.position.y = r * 0.14;
    g.add(brim, crown, band);
    g.position.set(f.at.x, f.at.y + f.top * 0.82, f.at.z);
  } else if (kind === 'cap') {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r * 1.1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), MAT(shade));
    dome.scale.y = 0.85;
    // The bill: a half disc out front, tipped down so it reads from eye level.
    const bill = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.85, r * 0.1, 24, 1, false, -Math.PI / 2, Math.PI),
      MAT(new THREE.Color(shade).multiplyScalar(0.7)));
    bill.position.set(0, r * 0.02, r * 0.75);
    bill.rotation.x = 0.28;
    g.add(dome, bill);
    g.position.set(f.at.x, f.at.y + f.top * 0.4, f.at.z);
  } else if (kind === 'chef_hat') {
    const white = MAT('#f7f5f0', 0.95);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.08, r * 1.08, r * 0.5, 24), white);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r * 1.3, 24, 14), white);
    band.position.y = r * 0.25;
    puff.position.y = r * 0.95; puff.scale.y = 0.75;
    g.add(band, puff);
    g.position.set(f.at.x, f.at.y + f.top * 0.62, f.at.z);
  } else if (kind === 'hard_hat') {
    const yellow = MAT('#f2c21b', 0.45);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r * 1.15, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), yellow);
    dome.scale.y = 0.9;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.4, r * 1.4, r * 0.07, 28), yellow);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(r * 0.22, r * 0.18, r * 2.1), yellow);
    ridge.position.y = r * 0.95;
    g.add(dome, brim, ridge);
    g.position.set(f.at.x, f.at.y + f.top * 0.45, f.at.z);
  } else if (kind === 'beanie') {
    const knit = MAT(look.top ? new THREE.Color(look.top).lerp(new THREE.Color('#ffffff'), 0.25) : '#c04040', 0.95);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r * 1.1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), knit);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.13, r * 1.13, r * 0.35, 24), knit);
    cuff.position.y = r * 0.1;
    g.add(dome, cuff);
    g.position.set(f.at.x, f.at.y + f.top * 0.42, f.at.z);
  } else if (kind === 'glasses') {
    const frame = MAT('#1e1c1e', 0.4);
    for (const s of [-1, 1]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.24, r * 0.035, 8, 20), frame);
      ring.position.set(s * r * 0.32, 0, 0);
      g.add(ring);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(r * 0.18, r * 0.04, r * 0.04), frame);
    g.add(bridge);
    g.position.set(f.at.x, f.at.y + f.top * 0.36, f.at.z + r * 0.98);
  } else if (kind === 'apron') {
    // From mid-chest to mid-thigh (bone heights), just in front of the body (and its belly).
    const top = f.hipsY + (f.neckY - f.hipsY) * 0.6, bottom = f.hipsY * 0.62, mid = (top + bottom) / 2;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.34, top - bottom), new THREE.MeshStandardMaterial({
      color: '#f4f1ea', roughness: 0.95, side: THREE.DoubleSide }));
    g.add(cloth);
    let z = -1;
    for (let k = 0; k <= 8; k++) z = Math.max(z, f.front?.(top + (bottom - top) * k / 8) ?? -1); // over the pocket and belly
    g.position.set(f.at.x, mid, (z > -1 ? z : f.at.z + 0.14) + 0.04); // clear of the walk's chest lean and the hem
    return { group: g, bone: 'spine' }; // the belly and pocket follow the spine, not the chest
  } else if (kind === 'tie') {
    // From just under the collar to the belt (bone heights, not the bounding box: hair spring bones stretch it).
    const silk = MAT('#8a2030', 0.5), top = f.neckY - 0.045, len = (top - f.hipsY) * 0.82;
    const knot = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.03, 0.02), silk);
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.012, len, 4, 1), silk);
    blade.rotation.y = Math.PI / 4; blade.scale.z = 0.3;
    knot.position.y = 0; blade.position.y = -0.015 - len / 2;
    g.add(knot, blade);
    g.position.set(f.at.x, top, (f.front?.(top - len * 0.3) ?? f.at.z + 0.12) + 0.008);
    // Lean the blade with the chest: from the collar's front to the belly's front.
    const zb = f.front?.(top - len * 0.95);
    if (zb != null) blade.rotation.x = 0, g.rotation.x = -Math.atan2(zb + 0.008 - g.position.z, len);
    return { group: g, bone: 'upperChest' };
  } else if (kind === 'scarf') {
    const h = f.height, wool = MAT(look.scarf || '#e8d9a8', 0.95);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.78, r * 0.2, 10, 24), wool);
    ring.rotation.x = Math.PI / 2; ring.scale.set(1, 0.82, 1.4);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(r * 0.32, h * 0.12, r * 0.1), wool);
    tail.position.set(r * 0.35, -h * 0.06, r * 0.7); tail.rotation.z = 0.12;
    g.add(ring, tail);
    g.position.set(f.at.x, f.at.y - f.top * 0.12, f.at.z + r * 0.05);
    return { group: g, bone: 'neck' };
  } else {
    return null;
  }
  return { group: g, bone: 'head' };
}

// Front of the body (max z, in the VRM's bind frame) at height y, near the middle.
function frontOf(vrm) {
  vrm.scene.updateMatrixWorld(true);
  const pts = [];
  const v = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const name = [].concat(o.material).map((m) => m.name).join(' ');
    if (!/_Tops_|_Body_/i.test(name)) return;
    const pos = o.geometry.attributes.position;
    for (let k = 0; k < pos.count; k += 2) { v.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld); pts.push(v.x, v.y, v.z); }
  });
  return (y) => {
    let best = -Infinity;
    for (let i = 0; i < pts.length; i += 3) if (Math.abs(pts[i + 1] - y) < 0.03 && Math.abs(pts[i]) < 0.07 && pts[i + 2] > best) best = pts[i + 2];
    return Number.isFinite(best) ? best : null;
  };
}

export function applyLook(hero, raw) {
  if (!raw) return;
  const look = resolveLook(raw);
  const vrm = hero.vrm;
  // The body first: the extras below sit on its (possibly wider) front.
  if (look.build || look.bulk) hero.build = applyBuild(vrm, look.build, { bulk: look.bulk ? { rx: /_Tops_/i, m: look.bulk } : null });
  const seen = new Set();
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      if (seen.has(mat)) continue;
      seen.add(mat);
      const name = mat.name || '';
      const baked = BAKED.find(([rx]) => rx.test(name));
      if (baked) { mat.visible = baked[1] !== null && look.accessory === baked[1]; continue; }
      const slot = SLOTS.find(([rx]) => rx.test(name))?.[1];
      if (slot && look[slot]) recolor(mat, look[slot], look.pattern?.slot === slot ? look.pattern : null);
    }
  });
  const hasBakedGlasses = [...seen].some((m) => /Glasses/i.test(m.name || ''));
  const kinds = [...look.extras];
  if (look.accessory && !(look.accessory === 'glasses' && hasBakedGlasses)) kinds.push(look.accessory);
  if (!kinds.length) return;
  // Put each accessory in the VRM's own (unscaled, bind-pose) frame, then hang
  // it on the bone so it follows the animation.
  const f = headFrame(vrm);
  f.front = frontOf(vrm);
  for (const kind of kinds) {
    const made = makeAccessory(kind, look, f);
    if (!made) continue;
    made.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    const bone = vrm.humanoid.getRawBoneNode(made.bone) ?? vrm.humanoid.getRawBoneNode('spine');
    // made.group is in world space (the character's group is at the origin
    // when the look is applied); attach() keeps that world transform. Adding it
    // under vrm.scene first would turn it by the VRM 0 half turn (rotateVRM0),
    // which put front pieces (cap bill, glasses, apron, tie) behind the body.
    made.group.updateMatrixWorld(true);
    bone.attach(made.group);
  }
}

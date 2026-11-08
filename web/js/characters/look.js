// A cast member's look (task 27): the plan picks clothing, hair and skin
// colors and maybe one accessory; this recolors the VRM's MToon materials and
// puts the accessory on the head (or the chest, for an apron).
//
//   applyLook(hero, { top: '#c8352e', bottom: '#23305e', hair: '#e0c070', skin: '#efc9ab', accessory: 'cap' })
//
// A cast without a look is left exactly as loaded (old cached scripts).
import * as THREE from 'three';

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
function grayTexture(tex, mean) {
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
  for (let i = 0; i < px.length; i += 4) {
    const y = Math.min(255, (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * k);
    px[i] = px[i + 1] = px[i + 2] = y;
  }
  g.putImageData(data, 0, 0);
  const out = new THREE.CanvasTexture(cv);
  out.colorSpace = tex.colorSpace;
  out.flipY = tex.flipY;
  out.wrapS = tex.wrapS; out.wrapT = tex.wrapT;
  out.channel = tex.channel;
  return out;
}

function recolor(mat, hex) {
  const c = new THREE.Color(hex);
  if (mat.map) {
    const gray = grayTexture(mat.map, 0.9);
    if (gray) mat.map = gray;
  }
  if (mat.shadeMultiplyTexture) mat.shadeMultiplyTexture = mat.map;
  mat.color?.copy(c);
  // Shade a little darker and cooler than the lit color, like VRoid's defaults.
  mat.shadeColorFactor?.copy(c).multiplyScalar(0.72).lerp(new THREE.Color('#6a5a7a'), 0.12);
  mat.needsUpdate = true;
}

function headFrame(vrm) {
  const head = vrm.humanoid.getRawBoneNode('head');
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const at = head.getWorldPosition(new THREE.Vector3());
  return { head, at, top: box.max.y - at.y, height: box.max.y - box.min.y };
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
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r * 1.12, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), MAT(shade));
    const bill = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, r * 0.06, 24, 1, false, -Math.PI / 2, Math.PI), MAT(shade));
    bill.position.set(0, 0, r * 0.6);
    g.add(dome, bill);
    g.position.set(f.at.x, f.at.y + f.top * 0.5, f.at.z);
  } else if (kind === 'chef_hat') {
    const white = MAT('#f7f5f0', 0.95);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.08, r * 1.08, r * 0.5, 24), white);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r * 1.3, 24, 14), white);
    band.position.y = r * 0.25;
    puff.position.y = r * 0.95; puff.scale.y = 0.75;
    g.add(band, puff);
    g.position.set(f.at.x, f.at.y + f.top * 0.62, f.at.z);
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
    const h = f.height;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(h * 0.19, h * 0.36), new THREE.MeshStandardMaterial({
      color: '#f4f1ea', roughness: 0.95, side: THREE.DoubleSide }));
    g.add(cloth);
    // From the chest to mid-thigh, just in front of the body.
    g.position.set(f.at.x, h * 0.6, f.at.z + h * 0.085);
    return { group: g, bone: 'chest' };
  } else {
    return null;
  }
  return { group: g, bone: 'head' };
}

export function applyLook(hero, look) {
  if (!look) return;
  const vrm = hero.vrm;
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
      if (slot && look[slot]) recolor(mat, look[slot]);
    }
  });
  const hasBakedGlasses = [...seen].some((m) => /Glasses/i.test(m.name || ''));
  if (!look.accessory || (look.accessory === 'glasses' && hasBakedGlasses)) return;
  // Put the accessory in the VRM's own (unscaled, bind-pose) frame, then hang
  // it on the bone so it follows the animation.
  const f = headFrame(vrm);
  const made = makeAccessory(look.accessory, look, f);
  if (!made) return;
  made.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  const bone = vrm.humanoid.getRawBoneNode(made.bone) ?? vrm.humanoid.getRawBoneNode('spine');
  vrm.scene.add(made.group); // the group above is identity here: scene frame = world
  bone.attach(made.group);
}

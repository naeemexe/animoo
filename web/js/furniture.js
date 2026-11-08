// Furniture for interiors (task 25), built from boxes and cylinders in the toon
// look instead of loaded from a GLB: the library had no chairs or tables, and
// these are cheap, real-size and consistent. Manifest entries use
// `file: "procedural:<id>"`. Every piece stands on y = 0, centered on x/z, with
// its front (where people sit or stand) toward +z.
import * as THREE from 'three';
import { toonMaterial } from './toon.js';

const mats = new Map();
const mat = (c) => { if (!mats.has(c)) mats.set(c, toonMaterial(c)); return mats.get(c); };

const WOOD = '#a8714a', DARK = '#6e4630', LIGHT = '#d7b48a', CLOTH = '#c9584a', CREAM = '#efe3cc';

function box(g, [w, h, d], [x, y, z], color) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(x, y + h / 2, z);
  g.add(m);
  return m;
}
function cyl(g, [r0, r1, h], [x, y, z], color, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), mat(color));
  m.position.set(x, y + h / 2, z);
  g.add(m);
  return m;
}
function legs(g, w, d, h, t, color, inset = 0.03) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, [t, h, t], [sx * (w / 2 - t / 2 - inset), 0, sz * (d / 2 - t / 2 - inset)], color);
}

const BUILD = {
  chair(g) { // seat 0.46 m high, backrest at -z
    legs(g, 0.44, 0.44, 0.44, 0.045, DARK);
    box(g, [0.48, 0.05, 0.48], [0, 0.44, 0.01], WOOD);
    box(g, [0.04, 0.5, 0.04], [-0.2, 0.49, -0.21], DARK);
    box(g, [0.04, 0.5, 0.04], [0.2, 0.49, -0.21], DARK);
    box(g, [0.44, 0.16, 0.035], [0, 0.78, -0.215], WOOD);
    box(g, [0.44, 0.05, 0.03], [0, 0.6, -0.215], WOOD);
  },
  armchair(g) {
    box(g, [0.9, 0.42, 0.82], [0, 0.02, 0], '#7d5a8c');
    box(g, [0.66, 0.12, 0.62], [0, 0.42, 0.06], '#9c7aab');
    box(g, [0.9, 0.5, 0.18], [0, 0.42, -0.33], '#7d5a8c');
    for (const s of [-1, 1]) box(g, [0.14, 0.22, 0.82], [s * 0.38, 0.42, 0], '#7d5a8c');
  },
  sofa(g) {
    box(g, [2.0, 0.4, 0.88], [0, 0.04, 0], '#5f7f9a');
    for (const s of [-0.48, 0.48]) box(g, [0.92, 0.12, 0.66], [s, 0.44, 0.07], '#7b9cb6');
    box(g, [2.0, 0.5, 0.2], [0, 0.44, -0.34], '#5f7f9a');
    for (const s of [-1, 1]) box(g, [0.16, 0.24, 0.88], [s * 0.92, 0.44, 0], '#5f7f9a');
    for (const s of [-1, 1]) for (const z of [-1, 1]) box(g, [0.06, 0.04, 0.06], [s * 0.9, 0, z * 0.36], DARK);
  },
  'dining-table'(g) { // round, 0.9 m, a cloth and a candle
    cyl(g, [0.07, 0.09, 0.7], [0, 0, 0], DARK, 10);
    cyl(g, [0.3, 0.32, 0.04], [0, 0, 0], DARK, 16);
    cyl(g, [0.46, 0.46, 0.04], [0, 0.7, 0], CREAM, 28);
    cyl(g, [0.47, 0.5, 0.12], [0, 0.6, 0], CREAM, 28);
    cyl(g, [0.03, 0.03, 0.12], [0, 0.74, 0], '#f4ead2', 8);
    cyl(g, [0.045, 0.045, 0.02], [0, 0.74, 0], '#b8925a', 10);
    for (const z of [-0.24, 0.24]) cyl(g, [0.11, 0.09, 0.015], [0, 0.74, z], '#ffffff', 18);
  },
  'table-long'(g) {
    legs(g, 1.6, 0.9, 0.71, 0.07, DARK, 0.06);
    box(g, [1.6, 0.05, 0.9], [0, 0.71, 0], WOOD);
    box(g, [0.5, 0.005, 0.9], [0, 0.76, 0], CLOTH);
  },
  'coffee-table'(g) {
    legs(g, 1.0, 0.55, 0.36, 0.05, DARK);
    box(g, [1.0, 0.05, 0.55], [0, 0.36, 0], WOOD);
    box(g, [0.24, 0.04, 0.18], [0.2, 0.41, 0.05], '#4f7fae');
    cyl(g, [0.05, 0.04, 0.1], [-0.25, 0.41, -0.05], '#e5d9be', 10);
  },
  bookshelf(g) {
    box(g, [1.2, 1.9, 0.04], [0, 0, -0.16], DARK);
    for (const s of [-1, 1]) box(g, [0.04, 1.9, 0.35], [s * 0.58, 0, 0], WOOD);
    const colors = ['#c9584a', '#4f7fae', '#e2b04a', '#5d9a6b', '#8a5aa0', '#d98a4e'];
    for (let i = 0; i < 5; i++) {
      const y = 0.02 + i * 0.44;
      box(g, [1.16, 0.035, 0.35], [0, y, 0], WOOD);
      if (i === 4) break;
      let x = -0.52;
      for (let j = 0; x < 0.48; j++) {
        const w = 0.05 + ((i * 7 + j * 3) % 5) * 0.012, h = 0.26 + ((i + j * 5) % 4) * 0.035;
        if ((i + j) % 9 !== 4) box(g, [w, h, 0.24], [x + w / 2, y + 0.035, 0.0], colors[(i * 3 + j) % colors.length]);
        x += w + 0.008;
      }
    }
  },
  counter(g) { // a bar or kitchen counter, its front panel toward +z
    box(g, [2.4, 1.0, 0.6], [0, 0, 0], '#8a5a3c');
    box(g, [2.5, 0.06, 0.7], [0, 1.0, 0], '#e9e1d2');
    for (let i = 0; i < 4; i++) box(g, [0.5, 0.7, 0.02], [-0.9 + i * 0.6, 0.15, 0.3], '#a0704c');
    for (const [x, c] of [[-0.8, '#5d9a6b'], [-0.65, '#c9584a'], [0.7, '#e2b04a']]) cyl(g, [0.035, 0.04, 0.26], [x, 1.06, -0.12], c, 10);
  },
  'potted-plant'(g) {
    cyl(g, [0.2, 0.15, 0.36], [0, 0, 0], '#c8734f', 14);
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), mat('#5f9a3e'));
    leaves.position.set(0, 0.72, 0); leaves.scale.set(1, 1.3, 1);
    g.add(leaves);
    const top = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), mat('#76b04f'));
    top.position.set(0.06, 1.0, 0.04);
    g.add(top);
  },
  'floor-lamp'(g) {
    cyl(g, [0.16, 0.18, 0.04], [0, 0, 0], DARK, 14);
    cyl(g, [0.02, 0.02, 1.3], [0, 0.04, 0], DARK, 8);
    const shade = cyl(g, [0.14, 0.24, 0.28], [0, 1.3, 0], '#f3dfae', 16);
    shade.userData.glow = true;
  },
  rug(g) {
    box(g, [2.4, 0.012, 1.6], [0, 0, 0], '#b8584a');
    box(g, [2.1, 0.014, 1.3], [0, 0, 0], '#d9a35a');
    box(g, [1.6, 0.016, 0.8], [0, 0, 0], '#9c4a46');
  },
  bed(g) {
    box(g, [1.5, 0.3, 2.0], [0, 0.1, 0], WOOD);
    box(g, [1.42, 0.18, 1.9], [0, 0.4, 0.02], '#f4efe4');
    box(g, [1.44, 0.08, 1.2], [0, 0.56, 0.38], '#6f8fc0');
    for (const s of [-1, 1]) box(g, [0.55, 0.12, 0.32], [s * 0.36, 0.58, -0.72], '#ffffff');
    box(g, [1.5, 0.9, 0.08], [0, 0.1, -1.0], DARK);
    legs(g, 1.5, 2.0, 0.1, 0.08, DARK, 0);
  },
  fireplace(g) {
    box(g, [1.6, 1.15, 0.5], [0, 0, 0], '#b9a48e');
    box(g, [1.8, 0.08, 0.6], [0, 1.15, 0.02], '#8a6f58');
    box(g, [0.8, 0.6, 0.06], [0, 0.08, 0.23], '#3a2a24');
    const fire = box(g, [0.5, 0.28, 0.04], [0, 0.1, 0.25], '#ffb347');
    fire.userData.glow = true;
  },
};

// A new piece of furniture (shared materials), or null for an unknown id.
export function buildFurniture(id) {
  const fn = BUILD[id];
  if (!fn) return null;
  const g = new THREE.Group();
  fn(g);
  g.traverse((m) => {
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
  });
  g.name = id;
  return g;
}

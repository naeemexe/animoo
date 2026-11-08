// Interiors (task 25): a room or a restaurant instead of an outdoor biome.
// The script's props and cast decide the room's size (an axis-aligned box
// around them with space for the camera); the fill adds the floor, four walls
// with windows and a door, a ceiling, skirting, pictures, lamps with warm
// light, and furniture against the walls that keeps off the action.
// `roomBounds()` is shared with the camera, which stays inside these walls.
import * as THREE from 'three';
import { loadProp } from '../library.js';
import { mulberry32 } from '../stage.js';
import { toonMaterial } from '../toon.js';

export const INTERIORS = new Set(['room', 'restaurant']);
export const isInterior = (script) => INTERIORS.has(script?.terrain?.biome);
const HEIGHT = 3.0;

// The room: { x0, x1, z0, z1, h } around every prop, start and walk target.
export function roomBounds(script) {
  const big = script.terrain?.biome === 'restaurant';
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const add = (x, z, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); };
  for (const p of script.props ?? []) add(p.position[0], p.position[1], 1.0);
  for (const c of script.cast ?? []) if (c.start?.position) add(...c.start.position, 0.8);
  for (const b of script.beats ?? []) if (Array.isArray(b.to)) add(...b.to, 0.8);
  if (!Number.isFinite(x0)) [x0, x1, z0, z1] = [-2, 2, -2, 2];
  // Room for the camera around the action, and a sensible minimum size.
  const pad = 2.2, minW = big ? 12 : 8.5, minD = big ? 10 : 7.5;
  x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
  const grow = (a, b, min) => { const c = (a + b) / 2, h = Math.max(min, b - a) / 2; return [c - h, c + h]; };
  [x0, x1] = grow(x0, x1, minW);
  [z0, z1] = grow(z0, z1, minD);
  return { x0, x1, z0, z1, h: HEIGHT };
}

// Window panes: the sky outside by time of day (unlit, so they glow).
const SKY = { sunrise: ['#f6c9a4', '#a9c3e4'], day: ['#e4f0f6', '#8fc0e8'], golden: ['#f6d29a', '#a9c7d8'],
  dusk: ['#f0a27c', '#5c6698'], night: ['#28335e', '#0e1430'] };
const STYLE = {
  room: { wall: '#ead8bb', low: '#b98f6a', floor: 'planks', ceiling: '#f4ecdc', trim: '#8a5f42' },
  restaurant: { wall: '#f0dfc2', low: '#a9503f', floor: 'tiles', ceiling: '#e9dcc6', trim: '#5e3a2a' },
};

function floorTexture(kind, w, d, rng) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  if (kind === 'tiles') { // a warm checkerboard
    const n = 8;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      g.fillStyle = (i + j) % 2 ? '#e8dcc4' : '#9a5a44';
      g.fillRect(i * 64, j * 64, 64, 64);
    }
  } else { // wooden planks with staggered joints
    const tones = ['#b07a50', '#a87048', '#b8845a', '#9e6a44'];
    for (let r = 0; r < 8; r++) {
      let x = -rng() * 200;
      while (x < 512) {
        const L = 160 + rng() * 140;
        g.fillStyle = tones[Math.floor(rng() * tones.length)];
        g.fillRect(x, r * 64, L, 64);
        g.fillStyle = 'rgba(70,40,25,0.55)';
        g.fillRect(x, r * 64, 3, 64);
        x += L;
      }
      g.fillStyle = 'rgba(70,40,25,0.6)';
      g.fillRect(0, r * 64, 512, 3);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const tile = kind === 'tiles' ? 4 : 5; // meters per texture repeat
  t.repeat.set(w / tile, d / tile);
  t.anisotropy = 4;
  return t;
}

function skyPane(tod) {
  const [lo, hi] = SKY[tod] ?? SKY.golden;
  const c = document.createElement('canvas');
  c.width = 4; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 64, 0, 0);
  grad.addColorStop(0, lo); grad.addColorStop(1, hi);
  g.fillStyle = grad; g.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, fog: false });
}

function slab(group, [w, h, d], [x, y, z], material, rotY = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = rotY;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

// One wall along its own x axis (length L), inner face toward +z, with
// openings: [{ at: center along the wall, w, y0, y1, kind: 'window' | 'door' }].
function wall(L, openings, S, pane, rng) {
  const g = new THREE.Group();
  const T = 0.16, wallM = toonMaterial(S.wall), lowM = toonMaterial(S.low), trimM = toonMaterial(S.trim);
  // Solid pieces between openings, built as vertical strips.
  const cuts = openings.map((o) => [o.at - o.w / 2, o.at + o.w / 2, o]).sort((a, b) => a[0] - b[0]);
  let x = -L / 2;
  const piece = (a, b, y0, y1) => {
    if (b - a < 0.01 || y1 - y0 < 0.01) return;
    // Wainscot below 0.95 m in the darker color, the wall above.
    if (y0 < 0.95) slab(g, [b - a, Math.min(y1, 0.95) - y0, T], [(a + b) / 2, y0, 0], lowM);
    if (y1 > 0.95) slab(g, [b - a, y1 - Math.max(y0, 0.95), T], [(a + b) / 2, Math.max(y0, 0.95), 0], wallM);
  };
  for (const [a, b, o] of cuts) {
    piece(x, a, 0, HEIGHT);
    piece(a, b, 0, o.y0);
    piece(a, b, o.y1, HEIGHT);
    // Frame and contents.
    const fw = 0.07;
    slab(g, [o.w + fw * 2, fw, T + 0.06], [o.at, o.y1, 0], trimM);
    if (o.y0 > 0) slab(g, [o.w + fw * 2, fw, T + 0.1], [o.at, o.y0 - fw, 0.02], trimM);
    for (const s of [-1, 1]) slab(g, [fw, o.y1 - o.y0, T + 0.06], [o.at + s * (o.w / 2 + fw / 2), o.y0, 0], trimM);
    if (o.kind === 'window') {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(o.w, o.y1 - o.y0), pane);
      p.position.set(o.at, (o.y0 + o.y1) / 2, -T / 2 - 0.02);
      g.add(p);
      // Mullions: a cross.
      slab(g, [0.04, o.y1 - o.y0, 0.05], [o.at, o.y0, -0.02], trimM);
      slab(g, [o.w, 0.04, 0.05], [o.at, (o.y0 + o.y1) / 2 - 0.02, -0.02], trimM);
    } else {
      slab(g, [o.w, o.y1 - o.y0, 0.06], [o.at, o.y0, -0.03], toonMaterial('#7a4e34'));
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), toonMaterial('#d8b25a'));
      knob.position.set(o.at + o.w * 0.36, 1.0, 0.03);
      g.add(knob);
    }
    x = b;
  }
  piece(x, L / 2, 0, HEIGHT);
  // Skirting and a picture rail along the inner face.
  slab(g, [L, 0.12, 0.03], [0, 0, T / 2 + 0.015], trimM);
  slab(g, [L, 0.05, 0.03], [0, 0.95, T / 2 + 0.015], trimM);
  slab(g, [L, 0.08, 0.05], [0, HEIGHT - 0.08, T / 2 + 0.02], trimM);
  g.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
  g.userData.rng = rng;
  return g;
}

function picture(rng, w, h) {
  const g = new THREE.Group();
  const colors = ['#5d8fb8', '#d98a4e', '#6aa56f', '#c9584a', '#e2b04a', '#8a6ab0'];
  slab(g, [w + 0.08, h + 0.08, 0.03], [0, -h / 2 - 0.04, 0], toonMaterial('#6e4630'));
  slab(g, [w, h, 0.035], [0, -h / 2, 0.005], toonMaterial('#f2e6cc'));
  // A simple painted landscape: hills and a sun.
  slab(g, [w * 0.9, h * 0.35, 0.04], [0, -h * 0.95, 0.008], toonMaterial(colors[Math.floor(rng() * 3) + 2]));
  slab(g, [w * 0.9, h * 0.45, 0.038], [0, -h * 0.6, 0.006], toonMaterial(colors[Math.floor(rng() * 2)]));
  const sun = new THREE.Mesh(new THREE.CircleGeometry(Math.min(w, h) * 0.12, 16), toonMaterial('#f6d36a'));
  sun.position.set(w * 0.2, -h * 0.3, 0.03);
  g.add(sun);
  return g;
}

// Furniture against the walls (and, in a restaurant, more tables) on spots
// clear of the action. `keep(x, z, margin)` is the fill's keep-out test.
function furnish(R, biome, keep, rng) {
  const items = []; // [id, x, z, rotationY]
  const taken = [];
  const free = (x, z, r) => !keep(x, z, r) && taken.every(([a, b, q]) => Math.hypot(x - a, z - b) > r + q);
  const put = (id, x, z, rot, r) => { if (!free(x, z, r)) return false; items.push([id, x, z, rot]); taken.push([x, z, r]); return true; };
  // Along each wall, facing into the room.
  const walls = [
    { n: [0, 1], at: (u, d) => [R.x0 + u * (R.x1 - R.x0), R.z0 + d], rot: 0 },
    { n: [0, -1], at: (u, d) => [R.x0 + u * (R.x1 - R.x0), R.z1 - d], rot: Math.PI },
    { n: [1, 0], at: (u, d) => [R.x0 + d, R.z0 + u * (R.z1 - R.z0)], rot: Math.PI / 2 },
    { n: [-1, 0], at: (u, d) => [R.x1 - d, R.z0 + u * (R.z1 - R.z0)], rot: -Math.PI / 2 },
  ];
  // Corners: plants and a lamp.
  for (const [x, z] of [[R.x0 + 0.5, R.z0 + 0.5], [R.x1 - 0.5, R.z0 + 0.5], [R.x0 + 0.5, R.z1 - 0.5], [R.x1 - 0.5, R.z1 - 0.5]]) {
    put(rng() < 0.6 ? 'potted-plant' : 'floor-lamp', x, z, 0, 0.4);
  }
  const along = biome === 'restaurant'
    ? ['counter', 'potted-plant', 'bookshelf', 'potted-plant']
    : ['bookshelf', 'fireplace', 'bookshelf', 'armchair', 'potted-plant', 'floor-lamp'];
  const depth = { counter: 0.45, bookshelf: 0.3, fireplace: 0.4, armchair: 0.6, 'potted-plant': 0.45, 'floor-lamp': 0.4 };
  const reach = { counter: 1.3, bookshelf: 0.7, fireplace: 0.95, armchair: 0.55, 'potted-plant': 0.4, 'floor-lamp': 0.3 };
  let k = 0;
  for (const w of walls) {
    for (const u of [0.3, 0.7, 0.5]) {
      const id = along[k % along.length];
      const [x, z] = w.at(u, depth[id]);
      if (put(id, x, z, w.rot, reach[id])) k++;
    }
  }
  if (biome === 'restaurant') {
    // Other diners' tables: a grid of two-seat tables wherever there's room.
    for (let x = R.x0 + 2.0; x < R.x1 - 1.6; x += 2.6) {
      for (let z = R.z0 + 2.0; z < R.z1 - 1.6; z += 2.6) {
        const jx = x + (rng() - 0.5) * 0.4, jz = z + (rng() - 0.5) * 0.4;
        if (!free(jx, jz, 1.25)) continue;
        put('dining-table', jx, jz, 0, 1.25);
        const a = rng() < 0.5 ? 0 : Math.PI / 2;
        for (const s of [1, -1]) items.push(['chair', jx + Math.sin(a) * s * 0.72, jz + Math.cos(a) * s * 0.72, a + (s > 0 ? Math.PI : 0)]);
      }
    }
  } else if (free((R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2, 0)) {
    items.push(['rug', (R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2, 0]);
  }
  return items;
}

// The interior fill: shell, lights, furniture. Returns a group like fillWorld's.
export async function interiorFill(stage, script, set, keep, { seed = 11 } = {}) {
  const biome = script.terrain.biome;
  const tod = script.terrain.time_of_day ?? 'golden';
  const S = STYLE[biome] ?? STYLE.room;
  const R = roomBounds(script);
  const rng = mulberry32(seed);
  const W = R.x1 - R.x0, D = R.z1 - R.z0, cx = (R.x0 + R.x1) / 2, cz = (R.z0 + R.z1) / 2;
  const fill = new THREE.Group();
  fill.name = 'fill';
  fill.userData.biome = biome;
  fill.userData.room = R;

  // Floor and ceiling.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), toonMaterial('#ffffff', { map: floorTexture(S.floor, W, D, rng) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0.001, cz);
  floor.receiveShadow = true;
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), toonMaterial(S.ceiling));
  ceil.rotation.x = Math.PI / 2; // faces down: seen from inside only
  ceil.position.set(cx, R.h, cz);
  fill.add(floor, ceil);
  for (let x = R.x0 + 1.5; x < R.x1 - 1; x += 3) slab(fill, [0.12, 0.14, D], [x, R.h - 0.14, cz], toonMaterial(S.trim)); // beams

  // Walls: windows on the long walls, a door on one short wall, pictures between.
  const pane = skyPane(tod);
  const wins = (L, n) => Array.from({ length: n }, (_, i) => ({ at: -L / 2 + (i + 0.5) * L / n, w: 1.2, y0: 0.95, y1: 2.35, kind: 'window' }));
  const specs = [
    { L: W, pos: [cx, R.z0], rot: 0, open: wins(W, Math.max(2, Math.round(W / 3.2))) },
    { L: W, pos: [cx, R.z1], rot: Math.PI, open: biome === 'restaurant' ? wins(W, Math.max(2, Math.round(W / 3.2))) : wins(W, 2).slice(0, 1) },
    { L: D, pos: [R.x0, cz], rot: Math.PI / 2, open: [{ at: D * 0.25, w: 1.0, y0: 0, y1: 2.15, kind: 'door' }] },
    { L: D, pos: [R.x1, cz], rot: -Math.PI / 2, open: [] },
  ];
  for (const s of specs) {
    const g = wall(s.L, s.open, S, pane, rng);
    g.position.set(s.pos[0], 0, s.pos[1]);
    g.rotation.y = s.rot;
    // Pictures in the gaps of a wall without windows.
    if (!s.open.some((o) => o.kind === 'window')) {
      for (const u of [-0.25, 0.2]) {
        if (s.open.some((o) => Math.abs(o.at - u * s.L) < 1.2)) continue;
        const p = picture(rng, 0.7 + rng() * 0.4, 0.5 + rng() * 0.25);
        p.position.set(u * s.L, 2.2, 0.1);
        g.add(p);
      }
    }
    fill.add(g);
  }

  // Lights: warm point lights under the ceiling (pendants in a restaurant).
  const lamp = new THREE.MeshBasicMaterial({ color: '#ffe2a8', fog: false });
  const night = tod === 'night' || tod === 'dusk';
  const nL = biome === 'restaurant' ? 3 : 2;
  for (let i = 0; i < nL; i++) {
    const x = R.x0 + (i + 0.5) * W / nL;
    const light = new THREE.PointLight('#ffd49a', night ? 9 : 4, 0, 1.6);
    light.position.set(x, R.h - 0.6, cz);
    fill.add(light);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 0.25, 16, 1, true), toonMaterial(biome === 'restaurant' ? '#3d5a4a' : '#e8d3a8', { side: THREE.DoubleSide }));
    shade.position.set(x, R.h - 0.55, cz);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), lamp);
    bulb.position.set(x, R.h - 0.62, cz);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.42, 4), toonMaterial('#333333'));
    cord.position.set(x, R.h - 0.21, cz);
    fill.add(shade, bulb, cord);
  }

  // Furniture: library props placed like the script's, but owned by the fill.
  const items = furnish(R, biome, keep, rng);
  const counts = { biome, trees: 0, bushes: 0, grass: 0, flowers: 0, rocks: 0, furniture: items.length, windows: 0 };
  counts.windows = specs.reduce((n, s) => n + s.open.filter((o) => o.kind === 'window').length, 0);
  const objs = await Promise.all(items.map(async ([id, x, z, rot]) => {
    try {
      const o = await loadProp(id);
      o.position.set(x, 0, z);
      o.rotation.y = rot;
      return o;
    } catch (err) { console.warn('interior:', err.message); return null; }
  }));
  for (const o of objs) if (o) fill.add(o);

  // No sky, hills or fog indoors; the island ground is replaced by the floor.
  if (stage.ground) stage.ground.visible = false;
  stage.scene.fog = null;
  stage.scene.userData.fogLocked = true;
  fill.userData.counts = counts;
  return fill;
}

// World fill: everything around the action that the script doesn't name.
// Instanced ground scatter (grass, flowers, rocks, bushes) that keeps off
// paths, water, props and the cast's walk lines; a dense ring of library trees
// out to the hills; far hills; distance fog; and a painted sky dome with
// layered mountains and a tree line, tinted for the script's time of day.
// Everything lives in one group inside the set, so it shows and hides with it.
import * as THREE from 'three';
import { loadProp } from '../library.js';
import { mulberry32 } from '../stage.js';
import { toonMaterial, faceted, smoothed } from '../toon.js';
import { addWind } from './atmosphere.js';
import { INTERIORS, interiorFill } from './interior.js';

const DOME_R = 300;

// Sky, haze and backdrop colors per time of day (lighting itself stays in world.js).
const PALETTE = {
  sunrise: { top: '#9fb6d8', mid: '#f2d3c0', horizon: '#f6c49a', fog: '#e9c9ae', far: '#b9a9c6', mid2: '#9a9bb4', near: '#7f9a86', trees: '#5f7f5c' },
  day: { top: '#8fbbe0', mid: '#cfe2ee', horizon: '#eef0dc', fog: '#d9e3d6', far: '#a9bccb', mid2: '#8fa9a4', near: '#76a06a', trees: '#5a8a52' },
  golden: { top: '#a9c7d8', mid: '#f3dcb2', horizon: '#f0b98a', fog: '#efcf9f', far: '#c4a9a8', mid2: '#a49a86', near: '#88985f', trees: '#667f48' },
  dusk: { top: '#4f5a8e', mid: '#b48aa8', horizon: '#f0a27c', fog: '#b98f8f', far: '#7d6c90', mid2: '#5f5878', near: '#4f5a5a', trees: '#3f4c45' },
  night: { top: '#0d1430', mid: '#1f2a52', horizon: '#3a4170', fog: '#222a48', far: '#2a3054', mid2: '#1f2442', near: '#1a2230', trees: '#121a22', stars: true, clouds: 'rgba(120,130,170,0.25)' },
};
// Weather greys the sky and pulls the haze in: [overcast color, mix, fog near, fog far].
const SKY_WEATHER = {
  rain: ['#7d8794', 0.6, 18, 120],
  snow: ['#d6dce4', 0.55, 16, 110],
  fog: ['#c9cdd2', 0.7, 4, 60],
};

function palette(tod, weather) {
  const P = { ...(PALETTE[tod] ?? PALETTE.golden) };
  P.fogNear = tod === 'night' ? 30 : 45;
  P.fogFar = tod === 'night' ? 190 : 230;
  const W = SKY_WEATHER[weather];
  if (!W) return P;
  const grey = new THREE.Color(W[0]);
  if (tod === 'night') grey.multiplyScalar(0.3);
  else if (tod === 'dusk') grey.multiplyScalar(0.7);
  for (const k of ['top', 'mid', 'horizon', 'fog', 'far', 'mid2']) P[k] = '#' + new THREE.Color(P[k]).lerp(grey, W[1]).getHexString();
  P.stars = false;
  P.clouds = tod === 'night' ? 'rgba(90,96,120,0.4)' : 'rgba(235,238,242,0.6)';
  [P.fogNear, P.fogFar] = [W[2], W[3]];
  return P;
}

// ---- keep-out: paths, water, props, walk lines ----------------------------

function segDist(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / L));
  return Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
}

function keepOut(script, set) {
  const discs = []; // [x, z, r]
  const lines = []; // [a, b, halfWidth]
  const t = script.terrain ?? {};
  for (const w of t.water ?? []) discs.push([w.center[0], w.center[1], w.radius + 0.6]);
  for (const p of t.paths ?? []) {
    const hw = (p.width ?? 1.2) / 2 + 0.25;
    for (let i = 0; i < p.points.length - 1; i++) lines.push([p.points[i], p.points[i + 1], hw]);
  }
  // Props: their real footprint, from the loaded models.
  const box = new THREE.Box3(), size = new THREE.Vector3();
  const propAt = {};
  for (const obj of set.children) {
    if (!obj.userData.prop) continue;
    box.setFromObject(obj).getSize(size);
    discs.push([obj.position.x, obj.position.z, Math.max(size.x, size.z) / 2 + 0.3]);
    propAt[obj.name] = [obj.position.x, obj.position.z];
  }
  // The cast: where they start and every point they walk to, in order.
  const castAt = {};
  for (const c of script.cast ?? []) castAt[c.id] = c.start?.position;
  const where = (to) => (Array.isArray(to) ? to : propAt[to] ?? castAt[to]);
  for (const c of script.cast ?? []) {
    let at = c.start?.position;
    if (!at) continue;
    discs.push([at[0], at[1], 1.2]);
    const beats = (script.beats ?? []).filter((b) => b.cast === c.id).sort((a, b) => a.start - b.start);
    for (const b of beats) {
      const to = b.to != null ? where(b.to) : null;
      if (!to) continue;
      lines.push([at, to, 1.0]);
      discs.push([to[0], to[1], 1.2]);
      at = to;
    }
  }
  if (!(script.cast ?? []).length) discs.push([0, 0, 3]); // Chat: the presenter stands at the origin
  return (x, z, margin = 0) => {
    for (const [cx, cz, r] of discs) if (Math.hypot(x - cx, z - cz) < r + margin) return true;
    for (const [a, b, hw] of lines) if (segDist(x, z, a, b) < hw + margin) return true;
    return false;
  };
}

// ---- instancing library props ---------------------------------------------

// One InstancedMesh per mesh in the prop, all sharing the same placements.
const FOLIAGE = ['#6cc79a', '#7fc77a', '#5fb48c', '#8ccf86', '#58a979', '#79bd8f'].map((c) => new THREE.Color(c));

async function instanced(id, placements, { shadow = false, hideNear = 0, camera, leaves = null, blockR = 0 } = {}) {
  if (!placements.length) return null;
  const proto = await loadProp(id);
  proto.updateMatrixWorld(true);
  const group = new THREE.Group();
  group.name = `fill-${id}`;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const base = placements.map(([x, z, rot, scale]) =>
    new THREE.Matrix4().compose(p.set(x, 0, z), q.setFromAxisAngle(up, rot), s.setScalar(scale)));
  const meshes = [];
  proto.traverse((node) => {
    if (!node.isMesh) return;
    // Foliage (the kit's teal) gets a per-instance green, so the forest
    // varies and leans greener than the hero props; trunks stay as they are.
    const c = node.material.color;
    const leafy = leaves && c && c.g > c.r * 1.2 && c.b > c.r;
    const mat = leafy ? node.material.clone() : node.material;
    if (leafy) { mat.color.set('#ffffff'); addWind(mat, 6); }
    const im = new THREE.InstancedMesh(node.geometry, mat, base.length);
    const local = node.matrixWorld.clone();
    base.forEach((b, i) => {
      im.setMatrixAt(i, m.multiplyMatrices(b, local));
      if (leafy) im.setColorAt(i, leaves[(i * 7 + 3) % leaves.length]);
    });
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.userData.local = local;
    meshes.push(im);
    group.add(im);
  });
  // Tall things near the film camera, or standing between it and what it
  // looks at, would fill the frame: drop them while that holds (checked per
  // render, re-uploaded only when something changes).
  if (hideNear && camera && meshes.length) {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const hidden = new Uint8Array(base.length);
    const fwd = new THREE.Vector3();
    let lastKey = '';
    meshes[0].onBeforeRender = (renderer, scene, cam) => {
      if (cam !== camera) return;
      cam.getWorldDirection(fwd);
      const key = `${cam.position.x.toFixed(2)},${cam.position.y.toFixed(2)},${cam.position.z.toFixed(2)},${fwd.x.toFixed(3)},${fwd.z.toFixed(3)}`;
      if (key === lastKey) return;
      lastKey = key;
      // Where the view meets the ground (about chest height), as a 2D segment.
      const reach = fwd.y < -0.02 ? Math.min(60, (cam.position.y - 0.8) / -fwd.y) : 40;
      const a = [cam.position.x, cam.position.z], b = [a[0] + fwd.x * reach, a[1] + fwd.z * reach];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let changed = false;
      for (let i = 0; i < base.length; i++) {
        // blockR: a fixed radius (buildings), else it grows with the tree's scale.
        const e = base[i].elements, sc = blockR ? 1 : Math.max(1, e[5]);
        const near = Math.hypot(e[12] - a[0], e[14] - a[1]) < hideNear * sc;
        // On the line of sight, short of the subject: the trunk side of the frame.
        const along = ((e[12] - a[0]) * (b[0] - a[0]) + (e[14] - a[1]) * (b[1] - a[1])) / (L * L);
        const block = along > 0 && along < 0.8 && segDist(e[12], e[14], a, b) < (blockR || 2.2 + 1.3 * sc);
        const h = near || block ? 1 : 0;
        if (h === hidden[i]) continue;
        hidden[i] = h;
        changed = true;
        for (const im of meshes) im.setMatrixAt(i, h ? zero : m.multiplyMatrices(base[i], im.userData.local));
      }
      if (changed) for (const im of meshes) im.instanceMatrix.needsUpdate = true;
    };
  }
  return group;
}

// A low tuft of five flat blades in two greens: about 10 triangles, so a
// meadow of thousands stays cheap (the library tuft is 224).
function grassTufts(placements, rng, colors = ['#8cbd52', '#b0d46c', '#7aab48']) {
  if (!placements.length) return Promise.resolve(null);
  const pos = [], col = [];
  const greens = colors.map((c) => new THREE.Color(c));
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rng() * 0.6, lean = 0.12 + rng() * 0.12;
    const bx = Math.cos(a) * 0.07, bz = Math.sin(a) * 0.07, w = 0.05;
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    const h = 0.22 + rng() * 0.18;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean);
    pos.push(bx + px, 0, bz + pz, bx - px, 0, bz - pz, bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean);
    const c = greens[k % 3];
    for (let v = 0; v < 6; v++) col.push(c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // Normals point up: blades shade like the ground under them (no dark
  // backs) and give the outline pass no normal edge, so the meadow stays soft.
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  const im = new THREE.InstancedMesh(geo, addWind(toonMaterial('#ffffff', { vertexColors: true }), 0.25), placements.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  placements.forEach(([x, z, rot, sc], i) => im.setMatrixAt(i, m.compose(p.set(x, 0, z), q.setFromAxisAngle(up, rot), s.setScalar(sc))));
  // No depth write (drawn last, still depth-tested): the ink pass finds no
  // depth edge on thin blades, so grass reads as soft texture, not scribbles.
  im.material.depthWrite = false;
  im.renderOrder = 2;
  im.receiveShadow = true;
  im.frustumCulled = false;
  im.name = 'fill-grass';
  return Promise.resolve(im);
}

// Low-poly bushes and boulders: a blob per instance, with a per-
// instance tint, so the edge of the clearing reads green and full.
function blobs(name, placements, rng, { detail = 0, stretch = [1, 0.75, 1], colors, shadow = true, lift = 0.45, poly = 'ico' }) {
  if (!placements.length) return Promise.resolve(null);
  const raw = poly === 'dodeca' ? new THREE.DodecahedronGeometry(0.5, detail) : new THREE.IcosahedronGeometry(0.5, detail);
  // Bushes (icosahedra) round off; rocks (dodecahedra) stay faceted.
  const geo = poly === 'dodeca' ? faceted(raw) : smoothed(raw);
  const im = new THREE.InstancedMesh(geo, toonMaterial('#ffffff'), placements.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  const cs = colors.map((c) => new THREE.Color(c));
  placements.forEach(([x, z, rot, sc], i) => {
    const sy = stretch[1] * sc * (0.85 + rng() * 0.3);
    s.set(stretch[0] * sc, sy, stretch[2] * sc * (0.8 + rng() * 0.4));
    q.setFromEuler(e.set((rng() - 0.5) * 0.3, rot, (rng() - 0.5) * 0.3));
    im.setMatrixAt(i, m.compose(p.set(x, sy * lift, z), q, s));
    im.setColorAt(i, cs[Math.floor(rng() * cs.length)]);
  });
  im.castShadow = shadow;
  im.receiveShadow = true;
  im.frustumCulled = false;
  im.name = `fill-${name}`;
  return Promise.resolve(im);
}

// Jittered-grid samples over an annulus, with a density function.
function scatter(rng, { r0, r1, step, density, blocked, margin = 0, scale = [0.8, 1.2] }) {
  const out = [];
  for (let x = -r1; x <= r1; x += step) {
    for (let z = -r1; z <= r1; z += step) {
      const px = x + (rng() - 0.5) * step * 0.9, pz = z + (rng() - 0.5) * step * 0.9;
      const r = Math.hypot(px, pz);
      if (r < r0 || r > r1) continue;
      if (rng() > (typeof density === 'function' ? density(px, pz, r) : density)) continue;
      if (blocked(px, pz, margin)) continue;
      out.push([px, pz, rng() * Math.PI * 2, scale[0] + rng() * (scale[1] - scale[0])]);
    }
  }
  return out;
}

// Smooth value noise for clumping (flowers in drifts, grass in meadows).
function noise2(seed) {
  const h = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  return (x, z) => {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
  };
}

// Split the placements across several prop ids.
function deal(rng, placements, ids) {
  const by = Object.fromEntries(ids.map((id) => [id, []]));
  for (const p of placements) by[ids[Math.floor(rng() * ids.length)]].push(p);
  return by;
}

// ---- ground, hills and sky -------------------------------------------------

// City paving: offset rows of flagstones with a few stains.
function pavingTexture(g, rng) {
  g.fillStyle = '#bdb7ad';
  g.fillRect(0, 0, 1024, 1024);
  const tones = ['#c4beb3', '#b6b0a6', '#c9c3b8', '#b1aba1'];
  for (let y = 0, row = 0; y < 1024; y += 32, row++) {
    for (let x = (row % 2) * 24; x < 1024 + 48; x += 48) {
      g.fillStyle = tones[Math.floor(rng() * tones.length)];
      g.fillRect(x - 48 + 1, y + 1, 46, 30);
    }
  }
  g.fillStyle = 'rgba(90,84,76,0.08)';
  for (let i = 0; i < 60; i++) {
    g.beginPath();
    g.ellipse(rng() * 1024, rng() * 1024, 8 + rng() * 30, 6 + rng() * 18, rng() * 3, 0, Math.PI * 2);
    g.fill();
  }
}

function groundTexture(P, rng, kind = 'meadow') {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  if (kind === 'paving') {
    pavingTexture(g, rng);
    return groundTex(c, 10);
  }
  const snowy = kind === 'snow';
  if (kind === 'sand' || kind === 'lawn') {
    // Sand: warm dunes and pebbles. Lawn: mown stripes, a few clover patches.
    const sand = kind === 'sand';
    g.fillStyle = sand ? '#ead6a2' : '#92c35c';
    g.fillRect(0, 0, 1024, 1024);
    if (!sand) for (let y = 0; y < 1024; y += 128) { g.fillStyle = '#9ccb66'; g.fillRect(0, y, 1024, 64); }
    const tones = sand ? ['#e3cd94', '#f0dfb4', '#dcc48a', '#efe0bb'] : ['#89ba54', '#a3cf6c', '#8fbf5a'];
    for (let i = 0; i < 500; i++) {
      const x = rng() * 1024, y = rng() * 1024, r = 6 + rng() * 30;
      g.fillStyle = tones[Math.floor(rng() * tones.length)];
      g.beginPath();
      g.ellipse(x, y, r, r * 0.6, rng() * 3, 0, Math.PI * 2);
      g.fill();
    }
    if (sand) for (let i = 0; i < 260; i++) {
      g.fillStyle = rng() < 0.5 ? '#c9b48a' : '#f7efd8';
      g.fillRect(rng() * 1024, rng() * 1024, 3, 2);
    }
    return groundTex(c, 10);
  }
  g.fillStyle = snowy ? '#e8eef5' : '#93c05a';
  g.fillRect(0, 0, 1024, 1024);
  // Snow: white drifts with a few grass patches showing through.
  const greens = snowy ? ['#f4f7fb', '#dde5ef', '#eef2f8', '#d3dde9', '#9fbb78']
    : ['#86b551', '#9fc865', '#7aa94a', '#a6c46a', '#8fb85a'];
  for (let i = 0; i < 700; i++) {
    const x = rng() * 1024, y = rng() * 1024, r = 4 + rng() * 26;
    g.fillStyle = rng() < 0.06 ? (snowy ? '#c9d3df' : '#b9a46e') : greens[Math.floor(rng() * greens.length)];
    g.beginPath();
    const n = 6 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, rr = r * (0.7 + rng() * 0.5);
      g[k ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8);
    }
    g.fill();
  }
  return groundTex(c, 10);
}

function groundTex(c, repeat) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

function ground(rng, kind = 'meadow') {
  const mat = toonMaterial('#ffffff', { map: groundTexture(null, rng, kind) });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(DOME_R * 0.95, 72), mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.002;
  disc.receiveShadow = true;
  disc.name = 'fill-ground';
  return disc;
}

// skip(a): no hill in that direction (the sea). colors: dunes instead of green hills.
function hills(rng, P, { colors = null, skip = null, n = 46, flat = 1 } = {}) {
  const g = new THREE.Group();
  g.name = 'fill-hills';
  const geo = smoothed(new THREE.IcosahedronGeometry(1, 2));
  const mats = (colors ?? [P.near, P.trees, '#7f9e5a']).map((c) => toonMaterial(c));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.12;
    if (skip?.(a)) { rng(); rng(); rng(); rng(); continue; }
    const r = 95 + rng() * 70;
    const w = 22 + rng() * 26, h = (8 + rng() * 16 + (r - 95) * 0.15) * flat;
    const hill = new THREE.Mesh(geo, mats[i % 3]);
    hill.scale.set(w, h, w * (0.6 + rng() * 0.5));
    hill.position.set(Math.cos(a) * r, -h * 0.25, Math.sin(a) * r);
    hill.rotation.y = rng() * Math.PI;
    g.add(hill);
  }
  return g;
}

// Equirectangular painting: sky gradient, three hazy mountain layers, a tree
// line on the horizon, all wrapping seamlessly around the dome.
// style.skyline: towers instead of mountains (city, park). style.seaU: the
// dome's u toward the sea, where the ridges sink below a flat sea horizon.
function skyTexture(P, seed, style = {}) {
  const W = 2048, H = 1024, hz = H / 2; // horizon at the middle
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, hz);
  grad.addColorStop(0, P.top);
  grad.addColorStop(0.62, P.mid);
  grad.addColorStop(1, P.horizon);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, hz);
  g.fillStyle = P.fog;
  g.fillRect(0, hz, W, H - hz);
  const rng = mulberry32(seed);
  // Stars and a moon at night.
  if (P.stars) {
    for (let i = 0; i < 700; i++) {
      const y = Math.pow(rng(), 1.4) * hz * 0.9;
      g.fillStyle = `rgba(255,250,235,${(0.35 + rng() * 0.65) * (1 - y / hz)})`;
      g.fillRect(rng() * W, y, rng() < 0.1 ? 2 : 1, rng() < 0.1 ? 2 : 1);
    }
    const mx = W * 0.62, my = hz * 0.42;
    const glow = g.createRadialGradient(mx, my, 0, mx, my, 60);
    glow.addColorStop(0, 'rgba(220,230,255,0.45)');
    glow.addColorStop(1, 'rgba(220,230,255,0)');
    g.fillStyle = glow;
    g.fillRect(mx - 60, my - 60, 120, 120);
    g.fillStyle = '#f4f1dc';
    g.beginPath();
    g.ellipse(mx, my, 14, 18, 0, 0, Math.PI * 2);
    g.fill();
  }
  // Soft cloud puffs.
  g.fillStyle = P.clouds ?? 'rgba(255,250,240,0.55)';
  for (let i = 0; i < 28; i++) {
    const x = rng() * W, y = hz * (0.25 + rng() * 0.5), w = 60 + rng() * 140;
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.ellipse(x + (k - 2) * w * 0.35, y + Math.sin(k * 1.7) * 6, w * (0.3 + rng() * 0.2), w * 0.12, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  // A periodic ridge: sum of sines with whole-number frequencies wraps at W.
  // How much land there is at x (0 toward the sea, 1 inland), smooth.
  const land = (x) => {
    if (style.seaU == null) return 1;
    let d = Math.abs(x / W - style.seaU);
    d = Math.min(d, 1 - d);
    return THREE.MathUtils.smoothstep(d, 0.12, 0.24);
  };
  const ridge = (freqs, amp, base, color) => {
    const ph = freqs.map(() => rng() * Math.PI * 2);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) {
      const u = (x / W) * Math.PI * 2;
      let y = 0;
      freqs.forEach((f, i) => { y += Math.sin(u * f + ph[i]) / (i + 1); });
      const k = land(x);
      g.lineTo(x, hz - (base + amp * (0.5 + 0.5 * y / 1.6)) * k + 3 * (1 - k));
    }
    g.lineTo(W, H);
    g.fill();
  };
  // A skyline: blocks of towers with a few lit or pale windows, wrapping at W.
  const skyline = (hMin, hMax, color, windows) => {
    for (let x = 0; x < W; ) {
      const w = 14 + rng() * 34, h = hMin + Math.pow(rng(), 1.6) * (hMax - hMin);
      g.fillStyle = color;
      g.fillRect(x, hz - h, w, h + 4);
      if (rng() < 0.25) g.fillRect(x + w * 0.4, hz - h - 10, 2, 10); // an antenna
      if (windows) {
        g.fillStyle = windows;
        for (let wy = hz - h + 5; wy < hz - 4; wy += 7) for (let wx = x + 3; wx < x + w - 4; wx += 6) if (rng() < 0.35) g.fillRect(wx, wy, 2, 3);
      }
      x += w + (rng() < 0.2 ? 6 + rng() * 10 : 0);
    }
  };
  if (style.skyline) {
    ridge([3, 7, 13, 23], 50, 10, P.far);
    skyline(30, style.skyline === 'city' ? 150 : 90, P.mid2, P.stars ? 'rgba(255,214,140,0.7)' : 'rgba(255,255,255,0.18)');
    if (style.skyline === 'city') skyline(14, 60, P.near, P.stars ? 'rgba(255,214,140,0.8)' : null);
  } else {
    ridge([3, 7, 13, 23], 120, 30, P.far);
    ridge([5, 11, 19, 31], 70, 12, P.mid2);
    ridge([4, 9, 17, 29], 34, 2, P.near);
  }
  if (style.seaU != null) {
    // The sea to the horizon, with a few glints.
    g.fillStyle = P.sea ?? '#6fa9c4';
    g.fillRect(0, hz - 1, W, H - hz + 1);
  }
  if (style.skyline === 'city') { g.fillRect(0, hz, W, 3); return skyTex(c); }
  // Tree line: rows of little crowns.
  g.fillStyle = P.trees;
  for (let x = 0; x < W + 12; x += 7 + rng() * 6) {
    if (land(x) < 0.5) continue;
    const h = 8 + rng() * 16, w = 5 + rng() * 5;
    g.beginPath();
    if (rng() < 0.5) {
      g.moveTo(x - w, hz + 2);
      g.lineTo(x, hz - h);
      g.lineTo(x + w, hz + 2);
    } else {
      g.ellipse(x, hz - h * 0.45, w, h * 0.55, 0, 0, Math.PI * 2);
    }
    g.fill();
  }
  if (style.seaU == null) g.fillRect(0, hz, W, 3);
  return skyTex(c);
}

function skyTex(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function dome(P, seed, style) {
  const mat = new THREE.MeshBasicMaterial({ map: skyTexture(P, seed, style), side: THREE.BackSide, fog: false, depthWrite: false });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(DOME_R, 48, 24), mat);
  sky.name = 'fill-sky';
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  // Follow the camera so the painted horizon never gets closer.
  sky.onBeforeRender = (r, scene, cam) => {
    sky.position.set(cam.position.x, 0, cam.position.z);
    sky.updateMatrixWorld();
    // Movie and Chat share one scene: the visible set's haze wins.
    if (sky.userData.fog && scene.fog !== sky.userData.fog) scene.fog = sky.userData.fog;
  };
  return sky;
}

// ---- the whole fill --------------------------------------------------------

// ---- biomes ------------------------------------------------------------------

// The sea: everything beyond a wavy shore line across the pond's side of the
// set. n is the unit direction from the set's middle to the pond, d0 the
// shore's distance along it.
function seaSide(script) {
  const w = script.terrain?.water?.[0];
  const c = w?.center ?? [7.5, 8.5], r = w?.radius ?? 4.8;
  const L = Math.hypot(c[0], c[1]) || 1;
  const n = [c[0] / L, c[1] / L];
  const d0 = Math.max(4, L - r * 0.5);
  const shore = (v) => d0 + 1.4 * Math.sin(v * 0.13 + 1.1) + 0.8 * Math.sin(v * 0.31);
  // (x, z) → (along n, across n)
  const uv = (x, z) => [x * n[0] + z * n[1], -x * n[1] + z * n[0]];
  return { n, d0, shore, wet: (x, z, m = 0) => { const [u, v] = uv(x, z); return u > shore(v) - m; } };
}

function seaMeshes(sea, P) {
  const g = new THREE.Group();
  g.name = 'fill-sea';
  const flat = (f) => ({ polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: f });
  const bands = [[-1.2, '#f4ecd6', -2, 0.006], [0, P.shallow, -3, 0.009], [3.5, P.sea, -4, 0.012]];
  const R = DOME_R * 0.94;
  for (const [off, color, f, y] of bands) {
    const pts = [];
    for (let v = -R; v <= R; v += 2) pts.push(new THREE.Vector2(v, sea.shore(v) + off + (off ? 0.35 * Math.sin(v * 0.5) : 0)));
    pts.push(new THREE.Vector2(R, R), new THREE.Vector2(-R, R));
    const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
    // Shape space (v, u) → world: x = u n.x - v n.z, z = u n.z + v n.x.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const v = pos.getX(i), u = pos.getY(i);
      pos.setXYZ(i, u * sea.n[0] - v * sea.n[1], y, u * sea.n[1] + v * sea.n[0]);
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const m = new THREE.Mesh(geo, toonMaterial(color, flat(f)));
    m.receiveShadow = true;
    g.add(m);
  }
  g.userData.ink = 0.4;
  return g;
}

// City blocks: 3×3 lots of 11 m with 9 m streets between blocks; the middle
// block is the open square the action plays on. Returns building and street
// lamp placements, and the street strips.
function cityBlocks(rng, blocked, { r0 = 24, r1 = 150, keepEvery = 1 } = {}) {
  const LOT = 11, BLOCK = 3 * LOT, STREET = 9, PERIOD = BLOCK + STREET;
  const buildings = { 'city-building-low': [], 'city-building-tall': [], 'city-building-tower': [], 'city-building-corner': [], 'city-garage': [], 'city-park-block': [] };
  const lamps = [], cars = [];
  const N = Math.ceil(r1 / PERIOD);
  for (let bi = -N; bi <= N; bi++) {
    for (let bj = -N; bj <= N; bj++) {
      if (bi === 0 && bj === 0) continue;
      for (let li = -1; li <= 1; li++) {
        for (let lj = -1; lj <= 1; lj++) {
          const x = bi * PERIOD + li * LOT, z = bj * PERIOD + lj * LOT;
          const r = Math.hypot(x, z);
          if (r < r0 || r > r1 || rng() > keepEvery || blocked(x, z, 6)) continue;
          // Taller toward the middle of the city, lower and greener far out.
          const far = r / r1, k = rng();
          const id = k < 0.06 ? 'city-park-block' : k < 0.12 ? 'city-garage'
            : k < 0.4 - far * 0.2 ? 'city-building-tower' : k < 0.62 ? 'city-building-tall' : k < 0.82 ? 'city-building-corner' : 'city-building-low';
          // Face the nearest street: outer lots turn out, the middle lot any way.
          const rot = li || lj ? (Math.abs(li) >= Math.abs(lj) ? (li > 0 ? -Math.PI / 2 : Math.PI / 2) : (lj > 0 ? Math.PI : 0)) : Math.floor(rng() * 4) * Math.PI / 2;
          buildings[id].push([x, z, rot, 0.98]);
        }
      }
    }
  }
  // Street lamps and parked cars along both sides of every street near the square.
  const streets = [];
  for (let s = -N; s < N; s++) {
    const c = s * PERIOD + PERIOD / 2;
    streets.push(c);
    for (let t = -r1; t <= r1; t += 14) {
      // Not in a crossing (the cross street's asphalt).
      const m = (((t - PERIOD / 2) % PERIOD) + PERIOD) % PERIOD;
      if (m < STREET / 2 + 0.6 || m > PERIOD - STREET / 2 - 0.6) continue;
      for (const side of [-1, 1]) {
        for (const [x, z, rot] of [[c + side * 4.35, t, 0], [t, c + side * 4.35, Math.PI / 2]]) {
          const r = Math.hypot(x, z);
          if (r > 70 || blocked(x, z, 0.5)) continue;
          lamps.push([x, z, rot, 1]);
          if (rng() < 0.3 && !blocked(x, z + 5, 2)) cars.push(rot ? [x + 5, z - side * 1.2, 0, 0.8] : [x - side * 1.2, z + 5, Math.PI / 2, 0.8]);
        }
      }
    }
  }
  return { buildings, lamps, cars, streets, half: STREET / 2 };
}

function streetMeshes(streets, half) {
  const g = new THREE.Group();
  g.name = 'fill-streets';
  const L = DOME_R * 1.8;
  const asphalt = toonMaterial('#6f6e72', { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const paint = toonMaterial('#f2efe4', { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const dash = new THREE.PlaneGeometry(0.18, 2.2);
  const dashes = [];
  for (const c of streets) {
    for (const vertical of [false, true]) {
      const road = new THREE.Mesh(new THREE.PlaneGeometry(vertical ? half * 2 - 1.4 : L, vertical ? L : half * 2 - 1.4), asphalt);
      road.rotation.x = -Math.PI / 2;
      road.position.set(vertical ? c : 0, 0.002, vertical ? 0 : c);
      road.receiveShadow = true;
      g.add(road);
      for (let t = -120; t <= 120; t += 5) dashes.push(vertical ? [c, t, 0] : [t, c, Math.PI / 2]);
    }
  }
  // Curbs: a low light-stone kerb along both edges of every street, broken
  // at the crossings, so the asphalt reads as set into the paving (task 28).
  const RW = half - 0.7, CW = 0.32;
  const sorted = [...streets].sort((a, b) => a - b);
  const curbs = [];
  for (const c of streets) {
    for (let k = 0; k < sorted.length - 1; k++) {
      const t0 = sorted[k] + RW, t1 = sorted[k + 1] - RW, mid = (t0 + t1) / 2, len = t1 - t0;
      for (const side of [-1, 1]) {
        const o = c + side * (RW + CW / 2);
        curbs.push([o, mid, len, 0, side], [mid, o, len, Math.PI / 2, side]);
      }
    }
  }
  const curbMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(CW, 0.13, 1), toonMaterial('#c9c4ba'), curbs.length);
  const cm = new THREE.Matrix4(), cq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  curbs.forEach(([x, z, len, rot], i) => curbMesh.setMatrixAt(i, cm.compose(new THREE.Vector3(x, 0.065, z), cq.setFromAxisAngle(up, rot), new THREE.Vector3(1, 1, len))));
  curbMesh.receiveShadow = true;
  curbMesh.frustumCulled = false;
  g.add(curbMesh);
  // A soft dark gutter just inside each curb, fading toward the lane.
  const gutterTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 1;
    const cx = cv.getContext('2d'), gr = cx.createLinearGradient(0, 0, 32, 0);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    cx.fillStyle = gr; cx.fillRect(0, 0, 32, 1);
    return new THREE.CanvasTexture(cv);
  })();
  const gutterMat = toonMaterial('#4f4e54', { alphaMap: gutterTex, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const gutter = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.9, 1).rotateX(-Math.PI / 2), gutterMat, curbs.length);
  const gq = new THREE.Quaternion();
  curbs.forEach(([x, z, len, rot, side], i) => {
    // Just inside the curb, its dark (u = 0) side against the curb.
    const vertical = rot === 0, off = -side * (CW / 2 + 0.45);
    const p = vertical ? new THREE.Vector3(x + off, 0.003, z) : new THREE.Vector3(x, 0.003, z + off);
    const flip = vertical ? side > 0 : side < 0;
    gq.setFromAxisAngle(up, rot + (flip ? Math.PI : 0));
    gutter.setMatrixAt(i, cm.compose(p, gq, new THREE.Vector3(1, 1, len)));
  });
  gutter.frustumCulled = false;
  gutter.renderOrder = 1;
  g.add(gutter);
  const im = new THREE.InstancedMesh(dash, paint, dashes.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  dashes.forEach(([x, z, rot], i) => im.setMatrixAt(i, m.compose(new THREE.Vector3(x, 0.004, z), q.setFromEuler(e.set(-Math.PI / 2, 0, rot)), new THREE.Vector3(1, 1, 1))));
  im.receiveShadow = true;
  g.add(im);
  g.userData.ink = 0.4;
  return g;
}

// ---- the whole fill --------------------------------------------------------

export async function fillWorld(stage, script, set, { seed = 11 } = {}) {
  const biome = script.terrain?.biome ?? 'forest';
  if (INTERIORS.has(biome)) return interiorFill(stage, script, set, keepOut(script, set), { seed });
  const P = palette(script.terrain?.time_of_day, script.terrain?.weather);
  // Strong blues: the toon light (lavender at sunrise) shifts them a lot.
  P.sea = '#' + new THREE.Color('#2f8fd0').lerp(new THREE.Color(P.fog), 0.12).getHexString();
  P.shallow = '#' + new THREE.Color('#5cc8d6').lerp(new THREE.Color(P.fog), 0.1).getHexString();
  const rng = mulberry32(seed);
  const sea = biome === 'sea' ? seaSide(script) : null;
  const keep = keepOut(script, set);
  const blocked = sea ? (x, z, m = 0) => sea.wet(x, z, m + 0.8) || keep(x, z, m) : keep;
  const meadow = noise2(seed), drift = noise2(seed + 5);
  const camera = stage.camera;
  const snowy = script.terrain?.weather === 'snow';

  const fill = new THREE.Group();
  fill.name = 'fill';
  fill.userData.biome = biome;
  const seaU = sea ? (((Math.atan2(sea.n[1], -sea.n[0]) / (Math.PI * 2)) % 1) + 1) % 1 : null;
  const sky = dome(P, seed, { skyline: biome === 'city' ? 'city' : biome === 'park' ? 'park' : null, seaU });
  const kind = snowy && biome !== 'city' ? 'snow' : { city: 'paving', sea: 'sand', park: 'lawn' }[biome] ?? 'meadow';
  const hillOpts = biome === 'sea'
    ? { colors: ['#d9c48e', '#b9b07a', '#9aa86a'], skip: (a) => Math.cos(a) * sea.n[0] + Math.sin(a) * sea.n[1] > -0.25, flat: 0.6 }
    : biome === 'city' ? { n: 0 } : biome === 'park' ? { flat: 0.5 } : {};
  fill.add(ground(rng, kind), hills(rng, P, hillOpts), sky);
  if (sea) fill.add(seaMeshes(sea, P));
  if (stage.ground) stage.ground.visible = false; // the fill's ground replaces the island

  // Fog: the haze color is the dome's horizon, so the ground melts into it.
  if (camera.far < DOME_R * 1.4) { camera.far = DOME_R * 1.4; camera.updateProjectionMatrix(); }
  stage.scene.fog = new THREE.Fog(P.fog, P.fogNear, P.fogFar);
  stage.scene.userData.fogLocked = true;
  sky.userData.fog = stage.scene.fog;

  const lobe = noise2(seed + 9), glade = noise2(seed + 13);
  const warped = (x, z, r) => r / (0.6 + 0.9 * lobe(x * 0.05 + 3.1, z * 0.05 - 1.7));
  const jobs = [];
  const counts = { biome, trees: 0, bushes: 0, grass: 0, flowers: 0, rocks: 0, small: 0, buildings: 0, lamps: 0 };
  const add = (k, list) => { counts[k] += list.length; return list; };

  if (biome === 'city') {
    // A paved square in a grid of blocks: buildings, streets, lamps, parked
    // cars, a few planted trees and hedges on the square's edge.
    const city = cityBlocks(rng, blocked);
    fill.add(streetMeshes(city.streets, city.half));
    for (const [id, p] of Object.entries(city.buildings)) {
      add('buildings', p);
      jobs.push(instanced(id, p, { shadow: true, hideNear: 12, blockR: 8, camera }));
    }
    jobs.push(instanced('lantern-post', add('lamps', city.lamps)));
    jobs.push(instanced('truck', city.cars, { hideNear: 5, blockR: 2.5, camera }));
    const planters = add('trees', scatter(rng, { r0: 12, r1: 22, step: 5, margin: 1.2, blocked, scale: [0.6, 0.8], density: 0.35 }));
    jobs.push(instanced('tree-round', planters, { hideNear: 7, camera, leaves: FOLIAGE }));
  } else if (biome === 'sea') {
    // A beach: sand, dune grass and driftwood rocks on the land side, the sea
    // to the horizon on the other, a few trees and dunes inland.
    const inland = (x, z) => -(x * sea.n[0] + z * sea.n[1]);
    const trees = add('trees', scatter(rng, { r0: 14, r1: 95, step: 4.5, margin: 1.6, blocked, scale: [0.85, 1.3],
      density: (x, z) => (inland(x, z) > 24 ? 0.45 : 0) }));
    const grass = add('grass', scatter(rng, { r0: 2, r1: 34, step: 0.9, margin: 0.2, blocked, scale: [0.9, 1.6],
      density: (x, z) => Math.max(0, meadow(x * 0.2, z * 0.2) - 0.45) * 1.8 }));
    const rocks = add('rocks', scatter(rng, { r0: 2, r1: 50, step: 2.6, margin: 0.3, blocked, scale: [0.7, 1.6],
      density: (x, z) => (sea.wet(x, z, 4) ? 0.35 : 0.05) }));
    const big = add('rocks', scatter(rng, { r0: 10, r1: 60, step: 7, margin: 1, blocked, scale: [0.8, 1.8], density: 0.12 }));
    // Palms along the beach (a generated prop of about 48k triangles, so at
    // most 20, the nearest), the kit's trees further inland.
    const palms = scatter(rng, { r0: 7, r1: 60, step: 5, margin: 2, blocked, scale: [0.8, 1.2],
      density: (x, z) => (inland(x, z) > -2 && inland(x, z) < 22 ? 0.5 : 0) })
      .sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1])).slice(0, 20);
    add('trees', palms);
    const treeIds = deal(rng, trees, ['pine-round', 'tree-round', 'pine-tall', 'tree-fat']);
    jobs.push(instanced('palm-tree', palms, { hideNear: 8, camera }));
    jobs.push(...Object.entries(treeIds).map(([id, p]) => instanced(id, p, { hideNear: 9, camera, leaves: FOLIAGE })));
    jobs.push(grassTufts(grass, rng, ['#b4c070', '#c9c784', '#9fb062']));
    jobs.push(blobs('rocks', rocks, rng, { poly: 'dodeca', stretch: [0.6, 0.38, 0.55], colors: ['#b8ad9a', '#9d9486', '#c7bca6'], lift: 0.3, shadow: false }));
    jobs.push(blobs('boulders', big, rng, { poly: 'dodeca', stretch: [1.8, 1.1, 1.5], colors: ['#a89f8e', '#8f897f', '#b9ae98'], lift: 0.32 }));
  } else if (biome === 'park') {
    // A city park: a mown lawn, scattered shade trees, hedges and flower beds,
    // lamps, and the city's towers past the trees.
    const trees = add('trees', scatter(rng, { r0: 8, r1: 80, step: 4.2, margin: 1.6, blocked, scale: [0.9, 1.4],
      density: (x, z, r) => { const re = warped(x, z, r); return re < 12 ? 0.04 : r < 45 ? 0.3 : 0.5; } }));
    const bushes = add('bushes', scatter(rng, { r0: 5, r1: 40, step: 3, margin: 0.7, blocked, scale: [0.6, 1.1], density: 0.18 }));
    const grass = add('grass', scatter(rng, { r0: 0, r1: 30, step: 0.9, margin: 0.15, blocked, scale: [0.6, 1.0], density: (x, z) => (0.15 + 0.3 * meadow(x * 0.18, z * 0.18)) }));
    const flowers = add('flowers', scatter(rng, { r0: 3, r1: 26, step: 0.8, margin: 0.1, blocked, scale: [0.9, 1.3], density: (x, z) => Math.max(0, drift(x * 0.25, z * 0.25) - 0.66) * 3 }));
    // Hedges in short rows around the lawn (end to end on rings), not strewn about.
    const hedges = [];
    for (const R of [16, 24]) {
      for (let a = 0; a < Math.PI * 2; a += 2 / R) {
        const x = Math.cos(a) * R, z = Math.sin(a) * R;
        if (lobe(a * 3 + R, R) < 0.55 || blocked(x, z, 0.6)) continue;
        hedges.push([x, z, Math.atan2(-z, x), 1]);
      }
    }
    add('small', hedges);
    const lamps = add('lamps', scatter(rng, { r0: 7, r1: 40, step: 7, margin: 0.6, blocked, scale: [1, 1], density: 0.16 }));
    const city = cityBlocks(rng, blocked, { r0: 95, r1: 160, keepEvery: 0.7 });
    const treeIds = deal(rng, trees, ['tree-round', 'tree-oak', 'tree-fat', 'tree-round', 'tree-autumn', 'pine-round']);
    jobs.push(...Object.entries(treeIds).map(([id, p]) => instanced(id, p, { hideNear: 9, camera, leaves: FOLIAGE })));
    jobs.push(blobs('bushes', bushes, rng, { detail: 1, stretch: [1.3, 0.9, 1.3], colors: ['#5f9a3e', '#6fa847', '#548c3a'], lift: 0.4 }));
    jobs.push(grassTufts(grass, rng));
    jobs.push(...Object.entries(deal(rng, flowers, ['flower-red', 'flower-yellow'])).map(([id, p]) => instanced(id, p)));
    jobs.push(instanced('hedge', hedges), instanced('lantern-post', lamps));
    for (const [id, p] of Object.entries(city.buildings)) if (id !== 'city-park-block') { add('buildings', p); jobs.push(instanced(id, p)); }
  } else {
    // Forest: a few trees at the edge of the play area, then a dense forest
    // out to the hills. The clearing's edge is warped by low-frequency noise
    // (lobes that reach in and out, glades and copses beyond it), so from
    // above it reads as a glade in a forest, not a round island.
    const trees = add('trees', scatter(rng, {
      r0: 7, r1: 95, step: 3.4, margin: 1.6, blocked, scale: [0.85, 1.45],
      density: (x, z, r) => {
        const re = warped(x, z, r);
        const d = re < 13 ? 0.1 : re < 19 ? 0.4 : r < 50 ? 0.9 : 0.55;
        return r > 22 && glade(x * 0.07, z * 0.07) > 0.68 ? d * 0.15 : d;
      },
    }));
    const bushes = add('bushes', scatter(rng, { r0: 4, r1: 40, step: 2.2, margin: 0.7, blocked, scale: [0.7, 1.4], density: (x, z, r) => (warped(x, z, r) < 10 ? 0.15 : 0.45) }));
    const grass = add('grass', scatter(rng, { r0: 0, r1: 34, step: 0.7, margin: 0.15, blocked, scale: [0.8, 1.5], density: (x, z) => (snowy ? 0.25 : 1) * (0.3 + 0.6 * meadow(x * 0.18, z * 0.18)) }));
    const flowers = add('flowers', scatter(rng, { r0: 0, r1: 28, step: 1.0, margin: 0.1, blocked, scale: [0.8, 1.4], density: (x, z) => (snowy ? 0 : 1) * Math.max(0, drift(x * 0.22, z * 0.22) - 0.45) * 1.6 }));
    const rocks = add('rocks', scatter(rng, { r0: 2, r1: 40, step: 3.2, margin: 0.3, blocked, scale: [0.7, 1.5], density: 0.14 }));
    const big = add('rocks', scatter(rng, { r0: 10, r1: 60, step: 7, margin: 1, blocked, scale: [0.8, 1.8], density: 0.22 }));
    const small = add('small', scatter(rng, { r0: 3, r1: 26, step: 4, margin: 0.2, blocked, scale: [0.8, 1.2], density: 0.12 }));

    const treeIds = deal(rng, trees, ['tree-oak', 'tree-round', 'tree-fat', 'pine-tall', 'pine-round', 'pine-tall', 'tree-oak', 'tree-autumn']);
    const flowerIds = deal(rng, flowers, ['flower-red', 'flower-yellow', 'flower-yellow']);
    const smallIds = deal(rng, small, ['mushrooms', 'stump']);
    jobs.push(
      ...Object.entries(treeIds).map(([id, p]) => instanced(id, p, { hideNear: 9, camera, leaves: FOLIAGE })),
      blobs('bushes', bushes, rng, { detail: 1, stretch: [1.4, 1.0, 1.4], colors: ['#5f9a3e', '#6fa847', '#548c3a', '#7bb04e'], lift: 0.4 }),
      grassTufts(grass, rng),
      ...Object.entries(flowerIds).map(([id, p]) => instanced(id, p)),
      blobs('rocks', rocks, rng, { poly: 'dodeca', stretch: [0.6, 0.38, 0.55], colors: ['#b8ad9a', '#a39a8a', '#c7bca6'], lift: 0.3, shadow: false }),
      blobs('boulders', big, rng, { poly: 'dodeca', stretch: [1.8, 1.1, 1.5], colors: ['#a89f8e', '#968e80', '#b9ae98'], lift: 0.32 }),
      ...Object.entries(smallIds).map(([id, p]) => instanced(id, p)),
    );
  }
  const groups = await Promise.all(jobs.map((j) => j.catch((err) => { console.warn('fill:', err.message); return null; })));
  for (const g of groups) if (g) fill.add(g);
  fill.userData.counts = counts;
  return fill;
}

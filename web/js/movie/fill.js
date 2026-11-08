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

async function instanced(id, placements, { shadow = false, hideNear = 0, camera, leaves = null } = {}) {
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
        const e = base[i].elements, sc = Math.max(1, e[5]);
        const near = Math.hypot(e[12] - a[0], e[14] - a[1]) < hideNear * sc;
        // On the line of sight, short of the subject: the trunk side of the frame.
        const along = ((e[12] - a[0]) * (b[0] - a[0]) + (e[14] - a[1]) * (b[1] - a[1])) / (L * L);
        const block = along > 0 && along < 0.8 && segDist(e[12], e[14], a, b) < 2.2 + 1.3 * sc;
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
function grassTufts(placements, rng) {
  if (!placements.length) return Promise.resolve(null);
  const pos = [], col = [];
  const greens = [new THREE.Color('#8cbd52'), new THREE.Color('#b0d46c'), new THREE.Color('#7aab48')];
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

function groundTexture(P, rng, snowy = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  tex.anisotropy = 4;
  return tex;
}

function ground(rng, snowy = false) {
  const mat = toonMaterial('#ffffff', { map: groundTexture(null, rng, snowy) });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(DOME_R * 0.95, 72), mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.002;
  disc.receiveShadow = true;
  disc.name = 'fill-ground';
  return disc;
}

function hills(rng, P) {
  const g = new THREE.Group();
  g.name = 'fill-hills';
  const geo = smoothed(new THREE.IcosahedronGeometry(1, 2));
  const mats = [toonMaterial(P.near), toonMaterial(P.trees), toonMaterial('#7f9e5a')];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + rng() * 0.12;
    const r = 95 + rng() * 70;
    const w = 22 + rng() * 26, h = 8 + rng() * 16 + (r - 95) * 0.15;
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
function skyTexture(P, seed) {
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
  const ridge = (freqs, amp, base, color) => {
    const ph = freqs.map(() => rng() * Math.PI * 2);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) {
      const u = (x / W) * Math.PI * 2;
      let y = 0;
      freqs.forEach((f, i) => { y += Math.sin(u * f + ph[i]) / (i + 1); });
      g.lineTo(x, hz - base - amp * (0.5 + 0.5 * y / 1.6));
    }
    g.lineTo(W, H);
    g.fill();
  };
  ridge([3, 7, 13, 23], 120, 30, P.far);
  ridge([5, 11, 19, 31], 70, 12, P.mid2);
  ridge([4, 9, 17, 29], 34, 2, P.near);
  // Tree line: rows of little crowns.
  g.fillStyle = P.trees;
  for (let x = 0; x < W + 12; x += 7 + rng() * 6) {
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
  g.fillRect(0, hz, W, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function dome(P, seed) {
  const mat = new THREE.MeshBasicMaterial({ map: skyTexture(P, seed), side: THREE.BackSide, fog: false, depthWrite: false });
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

export async function fillWorld(stage, script, set, { seed = 11 } = {}) {
  const P = palette(script.terrain?.time_of_day, script.terrain?.weather);
  const rng = mulberry32(seed);
  const blocked = keepOut(script, set);
  const meadow = noise2(seed), drift = noise2(seed + 5);
  const camera = stage.camera;

  const fill = new THREE.Group();
  fill.name = 'fill';
  const sky = dome(P, seed);
  const snowy = script.terrain?.weather === 'snow';
  fill.add(ground(rng, snowy), hills(rng, P), sky);
  if (stage.ground) stage.ground.visible = false; // the fill's ground replaces the island

  // Fog: the haze color is the dome's horizon, so the ground melts into it.
  if (camera.far < DOME_R * 1.4) { camera.far = DOME_R * 1.4; camera.updateProjectionMatrix(); }
  stage.scene.fog = new THREE.Fog(P.fog, P.fogNear, P.fogFar);
  stage.scene.userData.fogLocked = true;
  sky.userData.fog = stage.scene.fog;

  // Trees: a few at the edge of the play area, then a dense forest out to the
  // hills. The clearing's edge is warped by low-frequency noise (lobes that
  // reach in and out, glades and copses beyond it), so from above it reads as
  // a glade in a forest, not a round island.
  const lobe = noise2(seed + 9), glade = noise2(seed + 13);
  const warped = (x, z, r) => r / (0.6 + 0.9 * lobe(x * 0.05 + 3.1, z * 0.05 - 1.7));
  const trees = scatter(rng, {
    r0: 7, r1: 95, step: 3.4, margin: 1.6, blocked, scale: [0.85, 1.45],
    density: (x, z, r) => {
      const re = warped(x, z, r);
      const d = re < 13 ? 0.1 : re < 19 ? 0.4 : r < 50 ? 0.9 : 0.55;
      return r > 22 && glade(x * 0.07, z * 0.07) > 0.68 ? d * 0.15 : d;
    },
  });
  const bushes = scatter(rng, { r0: 4, r1: 40, step: 2.2, margin: 0.7, blocked, scale: [0.7, 1.4], density: (x, z, r) => (warped(x, z, r) < 10 ? 0.15 : 0.45) });
  const grass = scatter(rng, { r0: 0, r1: 34, step: 0.7, margin: 0.15, blocked, scale: [0.8, 1.5], density: (x, z) => (snowy ? 0.25 : 1) * (0.3 + 0.6 * meadow(x * 0.18, z * 0.18)) });
  const flowers = scatter(rng, { r0: 0, r1: 28, step: 1.0, margin: 0.1, blocked, scale: [0.8, 1.4], density: (x, z) => (snowy ? 0 : 1) * Math.max(0, drift(x * 0.22, z * 0.22) - 0.45) * 1.6 });
  const rocks = scatter(rng, { r0: 2, r1: 40, step: 3.2, margin: 0.3, blocked, scale: [0.7, 1.5], density: 0.14 });
  const big = scatter(rng, { r0: 10, r1: 60, step: 7, margin: 1, blocked, scale: [0.8, 1.8], density: 0.22 });
  const small = scatter(rng, { r0: 3, r1: 26, step: 4, margin: 0.2, blocked, scale: [0.8, 1.2], density: 0.12 });

  const treeIds = deal(rng, trees, ['tree-oak', 'tree-round', 'tree-fat', 'pine-tall', 'pine-round', 'pine-tall', 'tree-oak', 'tree-autumn']);
    const flowerIds = deal(rng, flowers, ['flower-red', 'flower-yellow', 'flower-yellow']);
  const smallIds = deal(rng, small, ['mushrooms', 'stump']);
  const jobs = [
    ...Object.entries(treeIds).map(([id, p]) => instanced(id, p, { hideNear: 9, camera, leaves: FOLIAGE })),
    blobs('bushes', bushes, rng, { detail: 1, stretch: [1.4, 1.0, 1.4], colors: ['#5f9a3e', '#6fa847', '#548c3a', '#7bb04e'], lift: 0.4 }),
    grassTufts(grass, rng),
    ...Object.entries(flowerIds).map(([id, p]) => instanced(id, p)),
    blobs('rocks', rocks, rng, { poly: 'dodeca', stretch: [0.6, 0.38, 0.55], colors: ['#b8ad9a', '#a39a8a', '#c7bca6'], lift: 0.3, shadow: false }),
    blobs('boulders', big, rng, { poly: 'dodeca', stretch: [1.8, 1.1, 1.5], colors: ['#a89f8e', '#968e80', '#b9ae98'], lift: 0.32 }),
    ...Object.entries(smallIds).map(([id, p]) => instanced(id, p)),
  ];
  const groups = await Promise.all(jobs.map((j) => j.catch((err) => { console.warn('fill:', err.message); return null; })));
  for (const g of groups) if (g) fill.add(g);
  fill.userData.counts = { trees: trees.length, bushes: bushes.length, grass: grass.length, flowers: flowers.length, rocks: rocks.length + big.length, small: small.length };
  return fill;
}

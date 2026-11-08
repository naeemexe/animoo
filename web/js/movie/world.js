// Builds the set from a scene script: terrain (light, a pond, paths) and
// library props. Returns the set's group; props are added as they load.
import * as THREE from 'three';
import { generateProp, loadManifest, loadProp } from '../library.js';
import { toonMaterial } from '../toon.js';
import { fillWorld } from './fill.js';
import { addAtmosphere } from './atmosphere.js';
import { INTERIORS } from './interior.js';

const RAD = Math.PI / 180;

const LIGHT = {
  sunrise: { sun: '#ffc48a', intensity: 2.8, pos: [-26, 14, 18], sky: '#d4c6ea', ground: '#c99a62', hemi: 1.45 },
  day: { sun: '#fff1d6', intensity: 3.2, pos: [-14, 30, 12], sky: '#c6d6ec', ground: '#b9a06a', hemi: 1.3 },
  golden: { sun: '#ffd29a', intensity: 3.2, pos: [-22, 26, 14], sky: '#c6c3ec', ground: '#c79a5e', hemi: 1.35 },
  dusk: { sun: '#ff9a6a', intensity: 2.2, pos: [-28, 9, 10], sky: '#9d93d0', ground: '#a07050', hemi: 1.2 },
  // Moonlight: cool, from high on the other side, with a deep blue fill.
  night: { sun: '#9fb6ff', intensity: 0.75, pos: [16, 30, -12], sky: '#4a5a9a', ground: '#2c2c48', hemi: 0.75 },
};
// Overcast weather dims the sun and greys the fill: [sun ×, fill color, mix].
const WEATHER = {
  rain: [0.35, '#8a94a6', 0.55],
  snow: [0.55, '#dfe6f0', 0.5],
  fog: [0.45, '#c8ccd2', 0.5],
};

// The ground the sun's shadow map covers: the props and everyone's start and
// walk targets, plus a margin (x, z, radius in meters).
export function shadowArea(script) {
  const pts = [];
  for (const p of script?.props ?? []) pts.push([p.position[0], p.position[1], 2.5 * (p.scale ?? 1)]);
  for (const c of script?.cast ?? []) if (c.start?.position) pts.push([...c.start.position, 1]);
  for (const b of script?.beats ?? []) if (Array.isArray(b.to)) pts.push([...b.to, 1]);
  if (!pts.length) return { x: 0, z: 0, r: 16 };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const x = (x0 + x1) / 2, z = (z0 + z1) / 2;
  let r = 0;
  for (const [px, pz, pad] of pts) r = Math.max(r, Math.hypot(px - x, pz - z) + pad);
  return { x, z, r: THREE.MathUtils.clamp(r + 5, 12, 36) };
}

// Fit the sun's shadow camera to the area (a tight box, so the map's texels
// are small), with its center snapped to whole texels in light space, so the
// shadow edges can't crawl when anything about the fit changes.
const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
export function fitShadow(stage, area = { x: 0, z: 0, r: 16 }, dir = stage.sun.position.clone().normalize()) {
  const sun = stage.sun, sc = sun.shadow.camera;
  const texel = (2 * area.r) / sun.shadow.mapSize.x;
  const D = 90;
  _m.lookAt(dir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)).extractBasis(..._ax);
  const c = _v.set(area.x, 0, area.z);
  const u = Math.round(c.dot(_ax[0]) / texel) * texel, w = Math.round(c.dot(_ax[1]) / texel) * texel, d = c.dot(_ax[2]);
  const snapped = new THREE.Vector3().addScaledVector(_ax[0], u).addScaledVector(_ax[1], w).addScaledVector(_ax[2], d);
  sun.target.position.copy(snapped);
  sun.position.copy(snapped).addScaledVector(dir, D);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();
  sc.left = sc.bottom = -area.r;
  sc.right = sc.top = area.r;
  sc.near = D - 40;
  sc.far = D + area.r + 30;
  sc.updateProjectionMatrix();
  // About one texel of bias, in world units, keeps acne off the toon bands.
  sun.shadow.normalBias = Math.max(0.02, texel * 1.5);
  sun.shadow.needsUpdate = true;
}

export function setTimeOfDay(stage, name = 'golden', weather = 'clear', script = null) {
  const L = LIGHT[name] ?? LIGHT.golden;
  const W = WEATHER[weather];
  stage.sun.color.set(L.sun);
  stage.sun.intensity = L.intensity * (W ? W[0] : 1);
  fitShadow(stage, shadowArea(script), new THREE.Vector3(...L.pos).normalize());
  stage.hemi.color.set(L.sky);
  stage.hemi.groundColor.set(L.ground);
  stage.hemi.intensity = L.hemi;
  if (W) {
    const grey = new THREE.Color(W[1]);
    if (name === 'night') grey.multiplyScalar(0.45);
    stage.hemi.color.lerp(grey, W[2]);
    stage.sun.color.lerp(grey, W[2] * 0.6);
  }
}

function pond({ center, radius }) {
  const g = new THREE.Group();
  const flat = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const shore = new THREE.Mesh(new THREE.CircleGeometry(radius + 0.5, 28), toonMaterial('#d9c08a', flat));
  const water = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), toonMaterial('#6fb8cf', { ...flat, polygonOffsetFactor: -3 }));
  const deep = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.55, 24), toonMaterial('#5aa2bf', { ...flat, polygonOffsetFactor: -4 }));
  for (const [m, y] of [[shore, 0.004], [water, 0.008], [deep, 0.012]]) {
    m.rotation.x = -Math.PI / 2;
    m.position.set(center[0], y, center[1]);
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// The walked path's color per biome: a dirt track, a sidewalk, sand, park gravel.
const PATH = { forest: '#e6c891', city: '#d8d2c6', sea: '#f1e3bd', park: '#e9d9b0' };

// Alpha masks for the path: a strip whose edges fade out with a slow wobble
// along its length, and a round end cap, so the path melts into the ground
// instead of ending at a hard line (task 28).
let edgeMasks = null;
function pathMasks() {
  if (edgeMasks) return edgeMasks;
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const make = (w, h, alpha) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = Math.round(255 * alpha(x / (w - 1), y / (h - 1)));
      img.data.set([a, a, a, 255], (y * w + x) * 4);
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  // Across: 0..1, along: 0..1 (repeats every 3 m). Solid core, soft broken edge.
  const wob = (v, k) => 0.05 * Math.sin(v * Math.PI * 2 + k) + 0.02 * Math.sin(v * Math.PI * 2 * 3 + 2 * k);
  const strip = make(64, 128, (u, v) => {
    const d = Math.abs(u - 0.5) * 2; // 0 centre, 1 edge
    const e = 0.86 + wob(v, u < 0.5 ? 0 : 1.7);
    return 1 - smooth(e - 0.48, e, d);
  });
  const cap = make(64, 64, (u, v) => 1 - smooth(0.38, 0.86, Math.hypot(u - 0.5, v - 0.5) * 2));
  cap.wrapT = THREE.ClampToEdgeWrapping;
  edgeMasks = { strip, cap };
  return edgeMasks;
}

function path({ points, width = 1.2 }, biome = 'forest') {
  const g = new THREE.Group();
  const masks = pathMasks();
  const opts = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 };
  const mat = toonMaterial(PATH[biome] ?? PATH.forest, { ...opts, alphaMap: masks.strip });
  const capMat = toonMaterial(PATH[biome] ?? PATH.forest, { ...opts, alphaMap: masks.cap });
  const W = width * 1.7; // the fade reaches past the old hard edge
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const geo = new THREE.PlaneGeometry(W, len);
    const uv = geo.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) * (len / 3) + i * 0.37);
    const strip = new THREE.Mesh(geo, mat);
    strip.rotation.set(-Math.PI / 2, 0, Math.atan2(b[0] - a[0], b[1] - a[1]));
    strip.position.set((a[0] + b[0]) / 2, 0.003, (a[1] + b[1]) / 2);
    strip.receiveShadow = true;
    strip.renderOrder = 1;
    g.add(strip);
  }
  for (const p of points) {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(W * 0.5, 20), capMat);
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(p[0], 0.0035, p[1]);
    dot.receiveShadow = true;
    dot.renderOrder = 1;
    g.add(dot);
  }
  g.userData.ink = 0.4;
  return g;
}

// Props the script names that the library doesn't have are generated first
// (one at a time, as the pod works), then everything is placed.
async function generateMissing(script, onStep) {
  const manifest = await loadManifest();
  const have = new Set(manifest.props.map((p) => p.id));
  const wanted = new Map();
  for (const p of script.props) if (!have.has(p.library) && !wanted.has(p.library)) wanted.set(p.library, p);
  for (const [id, p] of wanted) {
    const g = p.generate ?? {};
    await onStep(`search_library('${id}') → no match`, false, 'result');
    await onStep(`generating ${id}… generate_prop('${id}', "${g.prompt ?? id}"${g.size_m ? `, size_m=${g.size_m}` : ''}) · concept image → TRELLIS.2, about 45 s`, false, 'call');
    try {
      const r = await generateProp({ name: id, prompt: g.prompt, size_m: g.size_m, category: g.category });
      const [w, h, d] = r.entry.size;
      await onStep(r.cached
        ? `${id}: already in the library`
        : `${id} generated in ${Math.round(r.seconds)} s · ${w}×${h}×${d} m${r.normalize?.trimmed ? ' · ground slab trimmed' : ''} · saved to library/${r.entry.file}`, false, 'result');
    } catch (err) {
      await onStep(`generate_prop('${id}') failed: ${err.message}`, true, 'result');
    }
  }
  // Props generated on an earlier run are ordinary library hits now.
  for (const p of script.props) {
    const e = manifest.props.find((x) => x.id === p.library);
    if (e?.source === 'generated' && !wanted.has(p.library)) {
      await onStep(`search_library('${p.library}') → ${p.library} (generated earlier, from the library)`, false, 'result');
    }
  }
}

// `onStep(text, err, kind)` is called per step, for the agent log.
export async function buildSet(stage, script, onStep = () => {}) {
  const set = new THREE.Group();
  set.name = 'set';
  stage.scene.add(set);
  const t = script.terrain ?? {};
  setTimeOfDay(stage, t.time_of_day, t.weather, script);
  for (const w of t.water ?? []) set.add(pond(w));
  if (!INTERIORS.has(t.biome)) for (const p of t.paths ?? []) set.add(path(p, t.biome)); // indoors the floor is the path

  await generateMissing(script, onStep);
  const placed = await Promise.all(script.props.map(async (p) => {
    try {
      const obj = await loadProp(p.library);
      obj.position.set(p.position[0], 0, p.position[1]);
      obj.rotation.y = (p.rotation ?? 0) * RAD;
      obj.scale.multiplyScalar(p.scale ?? 1);
      obj.name = p.key;
      return { p, obj };
    } catch (err) {
      console.warn(`prop ${p.key}:`, err.message);
      return { p, err };
    }
  }));
  // Add in script order, so the log reads like the agent placing them.
  for (const { p, obj, err } of placed) {
    if (obj) set.add(obj);
    await onStep(err
      ? `place(${p.key}) failed: ${err.message}`
      : `place('${p.library}' as ${p.key}, at=(${p.position.join(', ')})${p.rotation ? `, rot=${p.rotation}°` : ''})`, !!err);
  }
  // Fill everything around the action: scatter, tree ring, hills, sky.
  try {
    const fill = await fillWorld(stage, script, set);
    set.add(fill);
    const c = fill.userData.counts;
    if (c.furniture !== undefined) await onStep(`fill_world(biome='${c.biome}') → a ${fill.userData.room ? `${(fill.userData.room.x1 - fill.userData.room.x0).toFixed(1)} × ${(fill.userData.room.z1 - fill.userData.room.z0).toFixed(1)} m ` : ''}room: floor, walls with ${c.windows} windows and a door, ceiling, lamps, ${c.furniture} pieces of furniture · keeps off the action`, false, 'result');
    else await onStep(`fill_world(biome='${c.biome}') → ${c.buildings ? `${c.buildings} buildings, ${c.lamps} street lamps, ` : ''}${c.trees} trees, ${c.bushes} bushes, ${c.grass} grass tufts, ${c.flowers} flowers, ${c.rocks} rocks · keeps off paths, water, props and walk lines`, false, 'result');
  } catch (err) {
    console.warn('fill:', err);
  }
  // Time of day and weather: lit windows and lamps, fire, rain or snow, wind.
  try {
    const atmo = addAtmosphere(stage, script, set);
    set.add(atmo);
    const a = atmo.userData.counts;
    await onStep(`set_weather(time_of_day='${t.time_of_day ?? 'golden'}', weather='${a.weather}') → ${[
      a.windows && `${a.windows} lit windows`, a.lamps && `${a.lamps} lamps`, a.fires && `${a.fires} campfire`,
      a.lights && `${a.lights} point lights`, a.weather === 'rain' || a.weather === 'snow' ? `${a.weather} particles` : null,
    ].filter(Boolean).join(', ') || 'light and sky only'}`, false, 'call');
  } catch (err) {
    console.warn('atmosphere:', err);
  }
  return set;
}

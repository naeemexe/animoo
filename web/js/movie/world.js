// Builds the set from a scene script: terrain (light, a pond, paths) and
// library props. Returns the set's group; props are added as they load.
import * as THREE from 'three';
import { generateProp, loadManifest, loadProp } from '../library.js';
import { toonMaterial } from '../toon.js';
import { fillWorld } from './fill.js';
import { addAtmosphere } from './atmosphere.js';

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

export function setTimeOfDay(stage, name = 'golden', weather = 'clear') {
  const L = LIGHT[name] ?? LIGHT.golden;
  const W = WEATHER[weather];
  stage.sun.color.set(L.sun);
  stage.sun.intensity = L.intensity * (W ? W[0] : 1);
  stage.sun.position.set(...L.pos);
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

function path({ points, width = 1.2 }) {
  const g = new THREE.Group();
  const mat = toonMaterial('#e6c891', { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(width, len), mat);
    strip.rotation.set(-Math.PI / 2, 0, Math.atan2(b[0] - a[0], b[1] - a[1]));
    strip.position.set((a[0] + b[0]) / 2, 0.003, (a[1] + b[1]) / 2);
    strip.receiveShadow = true;
    g.add(strip);
  }
  for (const p of points) {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(width / 2, 12), mat);
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(p[0], 0.003, p[1]);
    g.add(dot);
  }
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
  setTimeOfDay(stage, t.time_of_day, t.weather);
  for (const w of t.water ?? []) set.add(pond(w));
  for (const p of t.paths ?? []) set.add(path(p));

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
    await onStep(`fill_world() → ${c.trees} trees, ${c.bushes} bushes, ${c.grass} grass tufts, ${c.flowers} flowers, ${c.rocks} rocks · keeps off paths, water, props and walk lines`, false, 'result');
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

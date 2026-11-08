// Builds the set from a scene script: terrain (light, a pond, paths) and
// library props. Returns the set's group; props are added as they load.
import * as THREE from 'three';
import { loadProp } from '../library.js';
import { toonMaterial } from '../toon.js';

const RAD = Math.PI / 180;

const LIGHT = {
  sunrise: { sun: '#ffc48a', intensity: 2.8, pos: [-26, 14, 18], sky: '#d4c6ea', ground: '#c99a62', hemi: 1.45 },
  day: { sun: '#fff1d6', intensity: 3.2, pos: [-14, 30, 12], sky: '#c6d6ec', ground: '#b9a06a', hemi: 1.3 },
  golden: { sun: '#ffd29a', intensity: 3.2, pos: [-22, 26, 14], sky: '#c6c3ec', ground: '#c79a5e', hemi: 1.35 },
  dusk: { sun: '#ff9a6a', intensity: 2.2, pos: [-28, 9, 10], sky: '#9d93d0', ground: '#a07050', hemi: 1.2 },
};

export function setTimeOfDay(stage, name = 'golden') {
  const L = LIGHT[name] ?? LIGHT.golden;
  stage.sun.color.set(L.sun);
  stage.sun.intensity = L.intensity;
  stage.sun.position.set(...L.pos);
  stage.hemi.color.set(L.sky);
  stage.hemi.groundColor.set(L.ground);
  stage.hemi.intensity = L.hemi;
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

// `onStep(text)` is called per placed item, for the agent log.
export async function buildSet(stage, script, onStep = () => {}) {
  const set = new THREE.Group();
  set.name = 'set';
  stage.scene.add(set);
  const t = script.terrain ?? {};
  setTimeOfDay(stage, t.time_of_day);
  for (const w of t.water ?? []) set.add(pond(w));
  for (const p of t.paths ?? []) set.add(path(p));

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
  return set;
}

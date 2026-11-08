// The asset library: reads library/manifest.json and loads props at their
// real-world size, cel-shaded, with the pivot at bottom-center.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toonify } from './toon.js';
import { buildFurniture } from './furniture.js';
import { roundTree, isKitTree } from './foliage.js';
import { API_BASE } from './api.js';

export const LIBRARY_BASE = `${API_BASE}/library/`;

const loader = new GLTFLoader();
const templates = new Map(); // file → Promise<Object3D>, normalized once
let manifestPromise = null;

export function loadManifest() {
  manifestPromise ??= fetch(`${LIBRARY_BASE}manifest.json`, { cache: 'no-store' }).then((res) => {
    if (!res.ok) throw new Error(`manifest.json returned ${res.status}`);
    return res.json();
  });
  return manifestPromise;
}

// Props matching every given filter. `tag` matches a tag or the id.
export function findProps(manifest, { category, tag } = {}) {
  return manifest.props.filter((p) =>
    (!category || p.category === category) &&
    (!tag || p.id === tag || p.tags.includes(tag)));
}

// Scale uniformly so the height is size[1] meters, and move the model so its
// bounding box sits on y = 0 and is centered on x/z.
function normalize(model, entry) {
  const wrap = new THREE.Group();
  wrap.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const h = box.max.y - box.min.y;
  const s = h > 0 ? entry.size[1] / h : 1;
  model.scale.multiplyScalar(s);
  const c = box.getCenter(new THREE.Vector3());
  model.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  return wrap;
}

function template(entry) {
  if (!templates.has(entry.file) && entry.file.startsWith('procedural:')) {
    // Built in code at its real size (furniture.js), no file to load.
    const t = buildFurniture(entry.file.slice('procedural:'.length));
    if (!t) return Promise.reject(new Error(`no procedural prop "${entry.file}"`));
    const wrap = new THREE.Group();
    wrap.add(t);
    wrap.name = entry.id;
    templates.set(entry.file, Promise.resolve(wrap));
  }
  if (!templates.has(entry.file)) {
    const url = LIBRARY_BASE + entry.file;
    templates.set(entry.file, loader.loadAsync(url).then((gltf) => {
      const toon = toonify(gltf.scene);
      const t = normalize(isKitTree(entry) ? roundTree(toon, entry) : toon, entry);
      t.name = entry.id;
      return t;
    }));
  }
  return templates.get(entry.file);
}

// A new instance of a prop. `entry` is a manifest entry or a prop id.
export async function loadProp(entry) {
  if (typeof entry === 'string') {
    const m = await loadManifest();
    const found = m.props.find((p) => p.id === entry);
    if (!found) throw new Error(`no prop "${entry}" in manifest`);
    entry = found;
  }
  const obj = (await template(entry)).clone(true); // materials stay shared
  obj.userData.prop = entry;
  return obj;
}

// A prop the library doesn't have: the server's generate_prop tool makes it
// (concept image → TRELLIS.2, about 45 s), saves it to library/ and returns
// its manifest entry, or the existing entry at once if `name` is already there.
// The cached manifest picks the new entry up, so loadProp(id) works right after.
export async function generateProp({ name, prompt, size_m, category, seed }) {
  const res = await fetch(`${API_BASE}/api/props/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, prompt, size_m, category, seed }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `generate_prop returned ${res.status}`);
  const m = await loadManifest();
  if (!m.props.some((p) => p.id === body.entry.id)) m.props.push(body.entry);
  return body; // { entry, cached, seconds }
}

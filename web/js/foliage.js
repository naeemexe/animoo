// Rounder tree crowns for the low-poly kit trees (task 28). The Kenney
// crowns are 6–8-sided prisms whose silhouettes stay blocky however the
// normals are smoothed, so each crown mesh is rebuilt once per template:
// broadleaf crowns become a cluster of smooth puffs filling the old crown's
// volume, conifers a 16-sided lathe of their own radius profile (tiers kept).
// Trunks are untouched. About 1k vertices per crown, so the instanced forest
// stays cheap.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { smoothed } from './toon.js';

let unitPuff = null;
function puff() {
  // Indexed icosphere (162 vertices) with true sphere normals.
  unitPuff ??= (() => {
    const g = mergeVertices(new THREE.IcosahedronGeometry(1, 2).deleteAttribute('normal').deleteAttribute('uv'));
    g.computeVertexNormals();
    return g;
  })();
  return unitPuff;
}

// Centre, height range and the crown's radius in `n` height bins.
function profile(geo, n) {
  const p = geo.attributes.position;
  geo.computeBoundingBox();
  const b = geo.boundingBox, c = b.getCenter(new THREE.Vector3());
  const r = new Array(n).fill(0), H = b.max.y - b.min.y || 1;
  for (let i = 0; i < p.count; i++) {
    const k = Math.min(n - 1, Math.floor(((p.getY(i) - b.min.y) / H) * n));
    r[k] = Math.max(r[k], Math.hypot(p.getX(i) - c.x, p.getZ(i) - c.z));
  }
  return { b, c, H, r };
}

// Broadleaf: a core puff, a ring of five around the upper middle, three
// lower ones and a crown on top, each a sphere stretched to the crown's
// proportions. Overlapping lobes give the ink pass soft scalloped edges.
function puffCrown(geo, seed) {
  const { b, c, H } = profile(geo, 4);
  const hx = (b.max.x - b.min.x) / 2, hz = (b.max.z - b.min.z) / 2, hy = H / 2;
  const cy = b.min.y + hy;
  const rnd = (i) => { const s = Math.sin((i + 1) * 91.7 + seed * 13.3) * 43758.5; return s - Math.floor(s); };
  const parts = [];
  const add = (x, y, z, s) => {
    const g = puff().clone();
    g.scale(hx * s, hy * s, hz * s);
    g.translate(c.x + x * hx, cy + y * hy, c.z + z * hz);
    parts.push(g);
  };
  add(0, 0, 0, 0.72);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rnd(i) * 0.6;
    add(Math.cos(a) * 0.48, 0.12 + rnd(i + 9) * 0.12, Math.sin(a) * 0.48, 0.5 + rnd(i + 3) * 0.08);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.9 + rnd(i + 20) * 0.5;
    add(Math.cos(a) * 0.42, -0.4, Math.sin(a) * 0.42, 0.46);
  }
  add(rnd(30) * 0.12 - 0.06, 0.5, rnd(31) * 0.12 - 0.06, 0.48);
  const g = mergeGeometries(parts);
  g.userData.smoothed = true; // sphere normals already
  return g;
}

// Conifer: the old crown's radius profile in 12 bins, revolved with 16 sides.
// Folds sharper than the crease angle (the tiers' undersides) stay crisp.
function latheCrown(geo) {
  const n = 12;
  const { b, c, H, r } = profile(geo, n);
  const pts = [new THREE.Vector2(0.001, b.min.y)];
  for (let k = 0; k < n; k++) pts.push(new THREE.Vector2(Math.max(0.01, r[k] * 0.97), b.min.y + ((k + 0.5) / n) * H));
  pts.push(new THREE.Vector2(0.001, b.max.y));
  const g = new THREE.LatheGeometry(pts, 16);
  g.translate(c.x, 0, c.z);
  return smoothed(g, (50 * Math.PI) / 180);
}

// Rebuild the crowns of a loaded kit tree in place. `entry` is its manifest row.
export function roundTree(object, entry) {
  const conifer = entry.tags?.includes('pine') || entry.tags?.includes('conifer');
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const H = box.max.y - box.min.y;
  let i = 0;
  object.traverse((node) => {
    if (!node.isMesh || node.geometry.attributes.position.count < 30) return;
    // Trunks stand on the ground; crowns start well above it.
    const nb = new THREE.Box3().setFromObject(node);
    if (nb.min.y - box.min.y < H * 0.05) return;
    const old = node.geometry;
    node.geometry = conifer ? latheCrown(old) : puffCrown(old, i++);
    old.dispose();
    const m = node.material;
    if (m.vertexColors) { m.vertexColors = false; m.needsUpdate = true; }
  });
  return object;
}

// Kit trees only: generated trees (TRELLIS) are dense and already round.
export function isKitTree(entry) {
  return entry.file?.includes('kenney-nature/') && (entry.tags?.includes('tree') || entry.tags?.includes('pine'));
}

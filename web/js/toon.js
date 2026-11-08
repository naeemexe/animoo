// Cel-shaded materials. Every mesh in the world (library, generated, demo)
// goes through here so they all read as one set.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// Light bands, indexed by dot(N, L) * 0.5 + 0.5. Four texels:
// back (x2), terminator side, lit side.
const TONES = [0.0, 0.0, 0.5, 1.0];

let sharedGradient = null;

export function gradientMap() {
  if (sharedGradient) return sharedGradient;
  const data = new Uint8Array(TONES.map((t) => Math.round(t * 255)));
  const tex = new THREE.DataTexture(data, TONES.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  sharedGradient = tex;
  return tex;
}

// MeshToonMaterial has no flatShading, so low-poly facets come from the
// geometry: split vertices and give each face its own normal.
export function faceted(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.computeVertexNormals();
  return g;
}

// Smooth shading across shallow folds, hard edges at real corners: rounded
// low-poly shapes (tree crowns, bushes, hills, cones) stop reading as blocky
// facets under the two-band toon light, and the ink pass draws fewer lines
// inside them, while boxes, roofs and planks keep their crisp edges.
export const CREASE = 65 * Math.PI / 180; // hex-prism crowns (60°) round off, 90° corners stay
export function smoothed(geometry, crease = CREASE) {
  if (geometry.userData.smoothed) return geometry;
  const g = toCreasedNormals(geometry, crease);
  g.userData.smoothed = true;
  return g;
}

export function toonMaterial(color, opts = {}) {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: gradientMap(),
    ...opts,
  });
}

// Swap any loaded model's materials for toon ones, keeping color and texture.
export function toonify(object, { castShadow = true, receiveShadow = true } = {}) {
  object.traverse((node) => {
    if (!node.isMesh) return;
    // Some exports (the old trimesh props) ship without normals and shade black.
    if (!node.geometry.attributes.normal) node.geometry.computeVertexNormals();
    // Low-poly kit meshes: smooth the shallow folds. Dense generated meshes
    // (TRELLIS, tens of thousands of triangles) are smooth already.
    if (!node.isSkinnedMesh && node.geometry.attributes.position.count < 20000) node.geometry = smoothed(node.geometry);
    const swap = (m) => {
      if (m.isMeshToonMaterial) return m;
      const t = toonMaterial(m.color ? m.color.clone() : 0xffffff, {
        map: m.map ?? null,
        vertexColors: m.vertexColors ?? false,
        transparent: m.transparent ?? false,
        opacity: m.opacity ?? 1,
        side: m.side ?? THREE.FrontSide,
      });
      m.dispose();
      return t;
    };
    node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
    node.castShadow = castShadow;
    node.receiveShadow = receiveShadow;
  });
  return object;
}

// Cel-shaded materials. Every mesh in the world (library, generated, demo)
// goes through here so they all read as one set.
import * as THREE from 'three';

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

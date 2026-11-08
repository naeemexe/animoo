// Hand-drawn camera paths (task 19). A script may carry
//   camera_paths: [{ start, end, keys: [{ t, pos: [x, y, z], look: [x, y, z] }] }]
// For t inside [start, end] the camera follows a smooth spline through the
// keys (Catmull-Rom on position and look-at, timed by each key's t; it holds
// the first key before it and the last key after it) instead of the
// director's shot. Outside every span, or
// with no keys, nothing changes.
import * as THREE from 'three';

// The path whose span holds t, if it has at least one key.
export function pathAt(script, t) {
  return script?.camera_paths?.find((p) => p.keys?.length && t >= p.start && t <= p.end) ?? null;
}

// Catmull-Rom (uniform) between p1 and p2 at u, with p0/p3 as neighbors.
function cr(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return p1.map((_, i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * u
    + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u3));
}

// Camera pose on a path at t: { pos, look } as Vector3s.
export function samplePath(path, t) {
  const keys = [...path.keys].sort((a, b) => a.t - b.t);
  const n = keys.length;
  let pos, look;
  if (n === 1 || t <= keys[0].t) ({ pos, look } = keys[0]);
  else if (t >= keys[n - 1].t) ({ pos, look } = keys[n - 1]);
  else {
    let i = 0;
    while (i < n - 2 && t > keys[i + 1].t) i++;
    const a = keys[Math.max(0, i - 1)], b = keys[i], c = keys[i + 1], d = keys[Math.min(n - 1, i + 2)];
    let u = (t - b.t) / Math.max(c.t - b.t, 1e-3);
    // Two keys: ease in and out, so the move starts and stops gently.
    if (n === 2) u = u * u * (3 - 2 * u);
    pos = cr(a.pos, b.pos, c.pos, d.pos, u);
    look = cr(a.look, b.look, c.look, d.look, u);
  }
  return { pos: new THREE.Vector3(...pos), look: new THREE.Vector3(...look) };
}

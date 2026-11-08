// Joining clips into one continuous performance.
//
// B is turned and moved so its start lines up with A's end (root position on
// the ground plane, and heading), then the two overlap for `blend` seconds
// while the pose crossfades. Nothing is padded or looped: the result is
// A's frames, a short overlap, then B's frames. A final pass pins every
// planted foot so the crossfade can't make it skate.
import * as THREE from 'three';
import { Clip } from './clip.js';

const _a = new THREE.Quaternion();
const _b = new THREE.Quaternion();

const smooth = (x) => x * x * (3 - 2 * x);

// Circular mean of the heading over frames [from, to).
export function meanHeading(clip, from, to) {
  let s = 0, c = 0;
  for (let f = Math.max(from, 0); f < Math.min(to, clip.frames); f++) {
    const h = clip.heading(f);
    s += Math.sin(h); c += Math.cos(h);
  }
  return Math.atan2(s, c);
}

// `heading` (radians, 0 = +Z) turns B to start facing that way instead of A's
// end heading; the turn happens over the blend.
export function mergeClips(A, B, { blend = 0.3, heading } = {}) {
  if (A.fps !== B.fps) throw new Error(`clips differ in fps (${A.fps} vs ${B.fps})`);
  const n = Math.max(1, Math.min(Math.round(blend * A.fps), A.frames - 1, B.frames - 1));
  const start = A.frames - n; // first overlap frame in A

  // Align B's frame 0 to A's frame `start`: same heading, same root x/z.
  const b = B.clone();
  const turn = (heading ?? meanHeading(A, start, A.frames)) - meanHeading(b, 0, n);
  b.transform(turn, [b.hips[0], b.hips[2]], [A.hips[start * 3] - b.hips[0], A.hips[start * 3 + 2] - b.hips[2]]);
  const out = Clip.like(A, A.frames + B.frames - n, `${A.name} + ${B.name}`);
  for (let f = 0; f < start; f++) out.copyFrame(f, A, f);

  const B4 = A.bones.length * 4;
  for (let k = 0; k < n; k++) {
    const w = smooth((k + 1) / (n + 1));
    const fa = start + k, g = start + k;
    for (let i = 0; i < A.bones.length; i++) {
      _a.fromArray(A.rot, fa * B4 + i * 4);
      _b.fromArray(b.rot, k * B4 + i * 4);
      _a.slerp(_b, w).toArray(out.rot, g * B4 + i * 4);
    }
    // Root: A's own path keeps moving; B's is anchored where A was at `start`.
    // Blend the two positions, so the root decelerates or accelerates smoothly.
    for (let j = 0; j < 3; j++) {
      out.hips[g * 3 + j] = A.hips[fa * 3 + j] * (1 - w) + b.hips[k * 3 + j] * w;
      for (const s of ['left', 'right']) out.feet[s][g * 3 + j] = A.feet[s][fa * 3 + j] * (1 - w) + b.feet[s][k * 3 + j] * w;
    }
    for (const s of ['left', 'right']) out.contact[s][g] = A.contact[s][fa] && b.contact[s][k] ? 1 : 0;
  }
  for (let k = n; k < B.frames; k++) out.copyFrame(start + k, b, k);

  out.segments = [
    ...A.segments,
    ...B.segments.map((s) => ({ ...s, start: s.start + start, end: s.end + start })),
  ];
  out.blends = [...(A.blends ?? []), { start, end: start + n }, ...(B.blends ?? []).map((x) => ({ start: x.start + start, end: x.end + start }))];
  return plantFeet(out);
}

export function mergeAll(clips, opts) {
  return clips.reduce((acc, c) => (acc ? mergeClips(acc, c, opts) : plantFeet(c.clone())));
}

// For each run of planted frames, hold the foot target at one spot (the run's
// mean). Ease in and out over a few frames at the edges, so lifting and
// planting stay smooth. Fixes residual drift and any skate from crossfades.
export function plantFeet(clip, { ease = 4 } = {}) {
  for (const s of ['left', 'right']) {
    const p = clip.feet[s], c = clip.contact[s];
    let f = 0;
    while (f < clip.frames) {
      if (!c[f]) { f++; continue; }
      let e = f;
      while (e < clip.frames && c[e]) e++;
      let mx = 0, mz = 0;
      for (let g = f; g < e; g++) { mx += p[g * 3]; mz += p[g * 3 + 2]; }
      mx /= e - f; mz /= e - f;
      // Inside the run: locked. Within `ease` frames outside it: blend toward the lock.
      for (let g = Math.max(0, f - ease); g < Math.min(clip.frames, e + ease); g++) {
        const d = g < f ? f - g : g >= e ? g - e + 1 : 0;
        const w = d === 0 ? 1 : smooth(1 - d / (ease + 1));
        if (d > 0 && c[g]) continue;
        p[g * 3] += (mx - p[g * 3]) * w;
        p[g * 3 + 2] += (mz - p[g * 3 + 2]) * w;
      }
      f = e;
    }
  }
  return clip;
}

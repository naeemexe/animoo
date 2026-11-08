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
const _pa = new THREE.Quaternion();
const _pb = new THREE.Quaternion();

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

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _Y = new THREE.Vector3(0, 1, 0);
const _t = new THREE.Quaternion();

// The bones that carry the pose (legs, spine, arms), for pose matching.
const POSE_BONES = /^(hips|spine|chest|upperChest|neck|head|(left|right)(UpperLeg|LowerLeg|Foot|UpperArm|LowerArm|Shoulder))$/;

// Which of B's first `window` frames best continues A's frame `fa`: the pose
// (bone rotations relative to each clip's own heading) closest to A's. Ties
// go to the earliest frame, so a clip whose start already fits is not cut.
export function bestStart(A, fa, B, window) {
  const idx = A.bones.map((b, i) => (POSE_BONES.test(b) ? i : -1)).filter((i) => i >= 0);
  const B4 = A.bones.length * 4;
  const unA = _t.setFromAxisAngle(_Y, -A.heading(fa)).clone();
  let best = 0, score = Infinity;
  for (let k = 0; k <= Math.min(window, B.frames - 2); k++) {
    const unB = new THREE.Quaternion().setFromAxisAngle(_Y, -B.heading(k));
    let d = 0;
    for (const i of idx) {
      _a.fromArray(A.rot, fa * B4 + i * 4).premultiply(unA);
      _b.fromArray(B.rot, k * B4 + i * 4).premultiply(unB);
      d += _a.angleTo(_b) ** 2;
    }
    // Planted feet: prefer the same feet down.
    for (const s of ['left', 'right']) if (A.contact[s][fa] !== B.contact[s][k]) d += 0.05;
    d += 0.002 * k; // a little cost per skipped frame
    if (d < score - 1e-6) { score = d; best = k; }
  }
  return best;
}

function dropFrames(B, k0) {
  if (k0 <= 0) return B;
  const c = Clip.like(B, B.frames - k0, B.name);
  for (let f = 0; f < c.frames; f++) c.copyFrame(f, B, f + k0);
  c.segments = B.segments.map((s) => ({ ...s, start: Math.max(0, s.start - k0), end: Math.max(1, s.end - k0) }));
  c.blends = B.blends?.map((x) => ({ start: Math.max(0, x.start - k0), end: Math.max(0, x.end - k0) })).filter((x) => x.end > x.start);
  return c;
}

// `heading` (radians, 0 = +Z) turns B to start facing that way instead of A's
// end heading. The turn is spread over the blend: B's overlap frames are first
// turned back to A's heading and come round as the weight rises, so the pose
// crossfade only ever slerps between bodies facing the same way (a direct
// slerp across a big turn flips the short arc mid-blend and pops).
// `match` (seconds): B may start up to that far in, at the frame whose pose
// best continues A's (task 33), so a join never jumps pose.
// `anchorEnd`: B stands where A ends, not where A was when the blend starts (after a walk, the
// blend starts up to a second before the walker arrives: anchored there, they stopped short).
export function mergeClips(A, B, { blend = 0.5, heading, match = 0.4, anchorEnd = false } = {}) {
  if (A.fps !== B.fps) throw new Error(`clips differ in fps (${A.fps} vs ${B.fps})`);
  let n = Math.max(1, Math.min(Math.round(blend * A.fps), A.frames - 1, B.frames - 1));
  const start = A.frames - n; // first overlap frame in A
  if (match > 0 && B.frames > n + 2) B = dropFrames(B, bestStart(A, start, B, Math.min(Math.round(match * A.fps), B.frames - n - 2)));
  n = Math.max(1, Math.min(n, B.frames - 1));

  // Align B's frame 0 to A's frame `start`: same heading, same root x/z.
  const b = B.clone();
  const headA = meanHeading(A, start, A.frames);
  const target = heading ?? headA;
  const turn = target - meanHeading(b, 0, n);
  const af = anchorEnd ? A.frames - 1 : start;
  b.transform(turn, [b.hips[0], b.hips[2]], [A.hips[af * 3] - b.hips[0], A.hips[af * 3 + 2] - b.hips[2]]);
  const delta = wrap(target - headA);
  const pivot = [A.hips[af * 3], A.hips[af * 3 + 2]];
  const out = Clip.like(A, A.frames + B.frames - n, `${A.name} + ${B.name}`);
  for (let f = 0; f < start; f++) out.copyFrame(f, A, f);

  const B4 = A.bones.length * 4;
  for (let k = 0; k < n; k++) {
    const w = smooth((k + 1) / (n + 1));
    const fa = start + k, g = start + k;
    // B's frame k, turned back by the part of the turn not yet made.
    const back = -delta * (1 - w);
    if (Math.abs(back) > 1e-4) turnFrameAbout(b, k, back, pivot);
    // Crossfade each bone's rotation relative to its parent (world rotations
    // of hands and fingers can be far apart when the arm moves, and slerping
    // those flips the short arc mid-blend), then rebuild down the hierarchy.
    for (let i = 0; i < A.bones.length; i++) {
      const p = A.parents[i];
      _a.fromArray(A.rot, fa * B4 + i * 4);
      _b.fromArray(b.rot, k * B4 + i * 4);
      if (p >= 0) {
        _a.premultiply(_pa.fromArray(A.rot, fa * B4 + p * 4).invert());
        _b.premultiply(_pb.fromArray(b.rot, k * B4 + p * 4).invert());
      }
      _a.slerp(_b, w);
      if (p >= 0) _a.premultiply(_pa.fromArray(out.rot, g * B4 + p * 4));
      _a.toArray(out.rot, g * B4 + i * 4);
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

function turnFrameAbout(clip, f, yaw, pivot) {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  for (const arr of [clip.hips, clip.feet.left, clip.feet.right]) {
    const x = arr[f * 3] - pivot[0], z = arr[f * 3 + 2] - pivot[1];
    arr[f * 3] = c * x + sn * z + pivot[0];
    arr[f * 3 + 2] = -sn * x + c * z + pivot[1];
  }
  _t.setFromAxisAngle(_Y, yaw);
  const B4 = clip.bones.length * 4;
  for (let i = f * B4; i < f * B4 + B4; i += 4) _a.fromArray(clip.rot, i).premultiply(_t).toArray(clip.rot, i);
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

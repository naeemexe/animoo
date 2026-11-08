// Position control (task 22), game style: the scene decides where a character
// is and which way it faces; library clips only supply the body's motion.
//
//   pinRoot(clip)          an in-place action: remove the clip's own drift and turning
//   loopTo(clip, seconds)  repeat an in-place clip (idle, talk) to fill a beat
//   obstaclesFromSet(set)  prop footprints at body height, as oriented boxes
//   planPath(a, b, obs)    A* on a 0.25 m grid around them, then shortcut and smooth
//   warpToPath(clip, path) bend a straight walk/run clip onto a path, stride scaled to fit
//   lineClear / pushOut    free-space checks for drawn paths and other bodies (task 31)
import * as THREE from 'three';
import { Clip } from '../characters/clip.js';
import { mergeClips, plantFeet } from '../characters/merge.js';

const _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Turn frame f by `yaw` about the vertical through `pivot`, and move it by `off`.
function turnFrame(clip, f, yaw, pivot, off = [0, 0]) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const turn = _q.setFromAxisAngle(Y, yaw).clone();
  for (const arr of [clip.hips, clip.feet.left, clip.feet.right]) {
    const x = arr[f * 3] - pivot[0], z = arr[f * 3 + 2] - pivot[1];
    arr[f * 3] = c * x + s * z + pivot[0] + off[0];
    arr[f * 3 + 2] = -s * x + c * z + pivot[1] + off[1];
  }
  const B = clip.bones.length * 4;
  for (let i = f * B; i < f * B + B; i += 4) _q.fromArray(clip.rot, i).premultiply(turn).toArray(clip.rot, i);
}

// Moving average of a per-frame series over `w` frames.
function smoothSeries(v, w) {
  const out = new Float64Array(v.length), h = Math.max(1, Math.round(w / 2));
  for (let i = 0; i < v.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(v.length - 1, i + h); j++) { s += v[j]; n++; }
    out[i] = s / n;
  }
  return out;
}
function unwrap(v) {
  for (let i = 1; i < v.length; i++) v[i] = v[i - 1] + wrap(v[i] - v[i - 1]);
  return v;
}

// In place: the slow part of the hips' drift (over ~1 s) and of the heading is
// removed, so a wave or a talk stays where the scene put it and keeps facing
// its target. Fast sway (weight shifts, gestures) stays.
export function pinRoot(clip, { window = 1.0 } = {}) {
  const F = clip.frames, w = window * clip.fps;
  const hx = new Float64Array(F), hz = new Float64Array(F), hd = new Float64Array(F);
  for (let f = 0; f < F; f++) { hx[f] = clip.hips[f * 3]; hz[f] = clip.hips[f * 3 + 2]; hd[f] = clip.heading(f); }
  const sx = smoothSeries(hx, w), sz = smoothSeries(hz, w), sh = smoothSeries(unwrap(hd), w);
  for (let f = 0; f < F; f++) {
    const off = [-(sx[f] - sx[0]), -(sz[f] - sz[0])];
    turnFrame(clip, f, -(sh[f] - sh[0]), [hx[f], hz[f]], off);
  }
  return plantFeet(clip);
}

// Change the playback speed (factor > 1 is slower): slerped bones, lerped positions.
export function resample(clip, factor) {
  if (Math.abs(factor - 1) < 0.01) return clip;
  const frames = Math.round((clip.frames - 1) * factor) + 1;
  const out = Clip.like(clip, frames);
  const B = clip.bones.length * 4, a = new THREE.Quaternion(), b = new THREE.Quaternion();
  for (let g = 0; g < frames; g++) {
    const u = Math.min(g / factor, clip.frames - 1), f0 = Math.floor(u), f1 = Math.min(f0 + 1, clip.frames - 1), w = u - f0;
    for (let i = 0; i < B; i += 4) {
      a.fromArray(clip.rot, f0 * B + i); b.fromArray(clip.rot, f1 * B + i);
      a.slerp(b, w).toArray(out.rot, g * B + i);
    }
    for (const [src, dst] of [[clip.hips, out.hips], [clip.feet.left, out.feet.left], [clip.feet.right, out.feet.right]]) {
      for (let j = 0; j < 3; j++) dst[g * 3 + j] = src[f0 * 3 + j] * (1 - w) + src[f1 * 3 + j] * w;
    }
    for (const s of ['left', 'right']) out.contact[s][g] = clip.contact[s][w < 0.5 ? f0 : f1];
  }
  return out;
}

// Append `filler` (default: the clip itself) until it lasts `seconds` (blended joins).
export function loopTo(clip, seconds, filler = clip, { blend = 0.5 } = {}) {
  let out = clip;
  while (out.duration < seconds - 0.05 && filler.duration > blend * 2) out = mergeClips(out, filler, { blend });
  return out;
}

// A beat's library action → what the director needs:
// { clip, root: 'path' | 'pinned' | 'free', variants (locomotion, by length), minFrames, action }.
// `minFrames`: sitting down and standing up are never cut shorter; the next beat waits instead.
export function prepareAction(makeClip, beat, m) {
  const prep = ({ meta, text }) => {
    let c = makeClip(text, beat.id);
    if (meta.time_scale) c = resample(c, meta.time_scale);
    if (meta.root === 'pinned') c = pinRoot(c);
    return c;
  };
  const meta = m.variants[0].meta;
  const variants = m.variants.map(prep);
  let clip = variants[0];
  // Sitting down and standing up are never cut short; the director cuts the rest to the beat.
  const minFrames = /^(sit_bench|sit_ground|stand_up)/.test(meta.id) && !/idle|talk/.test(meta.id) ? clip.frames : 1;
  // Loops get spare length (10 s), so a beat that the director stretches to wait for someone keeps moving.
  if (meta.root !== 'path' && m.filler) clip = loopTo(clip, beat.duration + 10, m.filler.meta.id === meta.id ? clip : prep(m.filler));
  return { clip, root: meta.root, variants, minFrames, action: m.action };
}

// ---- obstacles ----------------------------------------------------------------

// Each prop's footprint where a body passes (0.05–1.4 m up), as a box in the
// prop's own frame: {c: [x, z], h: [hx, hz], rot}. Low things (flowers, grass,
// lily pads, paths) aren't obstacles; a tree is only its trunk.
export function obstaclesFromSet(set) {
  const out = [];
  const inv = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const obj of set.children) {
    if (!obj.userData.prop) continue;
    obj.updateMatrixWorld(true);
    inv.copy(obj.matrixWorld).invert();
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
    obj.traverse((m) => {
      const pos = m.isMesh && m.geometry?.attributes?.position;
      if (!pos) return;
      const step = Math.max(1, Math.floor(pos.count / 6000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        if (v.y > top) top = v.y;
        if (v.y < 0.05 || v.y > 1.4) continue;
        v.applyMatrix4(inv).multiply(obj.scale); // the prop's frame, in meters, unrotated
        if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
        if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
      }
    });
    // Flowers, grass tufts, lily pads: walk through them. A bench (0.43 m) is in the way.
    if (!(x1 > x0) || top < 0.3 || /flower|grass|lily|mushroom|pebble/.test(obj.userData.prop.id ?? '')) continue;
    const rot = obj.rotation.y, c = Math.cos(rot), s = Math.sin(rot);
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    out.push({
      key: obj.name,
      c: [obj.position.x + c * mx + s * mz, obj.position.z - s * mx + c * mz],
      h: [(x1 - x0) / 2, (z1 - z0) / 2],
      rot,
    });
  }
  return out;
}

// Signed distance from a point to an obstacle box (negative inside).
function boxDist(o, x, z) {
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const dx = x - o.c[0], dz = z - o.c[1];
  const lx = c * dx - s * dz, lz = s * dx + c * dz; // into the box's frame
  const qx = Math.abs(lx) - o.h[0], qz = Math.abs(lz) - o.h[1];
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

// ---- free space (task 31) -----------------------------------------------------

// Is a polyline clear of the obstacles (by `clearance`)? Obstacles touching its
// ends are ignored (leaving a bench, stopping at a table), as planPath does.
export function lineClear(pts, obstacles, { clearance = BODY } = {}) {
  const a = pts[0], b = pts.at(-1);
  const obs = obstacles.filter((o) => boxDist(o, a[0], a[1]) >= clearance && boxDist(o, b[0], b[1]) >= clearance);
  if (!obs.length) return true;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (CELL / 2)));
    for (let j = 0; j <= n; j++) {
      const x = p[0] + (q[0] - p[0]) * j / n, z = p[1] + (q[1] - p[1]) * j / n;
      if (obs.some((o) => boxDist(o, x, z) < clearance)) return false;
    }
  }
  return true;
}

// The nearest spot to p that is `clearance` clear of every obstacle (p itself if it is).
export function pushOut(p, obstacles, { clearance = BODY } = {}) {
  const free = (x, z) => obstacles.every((o) => boxDist(o, x, z) >= clearance);
  if (free(p[0], p[1])) return p;
  for (let r = 0.1; r <= 4; r += 0.1) {
    for (let a = 0; a < 360; a += 15) {
      const q = [p[0] + Math.sin(a * Math.PI / 180) * r, p[1] + Math.cos(a * Math.PI / 180) * r];
      if (free(q[0], q[1])) return q;
    }
  }
  return p;
}

// ---- paths --------------------------------------------------------------------

const CELL = 0.25;
const BODY = 0.45; // clearance from a prop's footprint to the hips' line

// A walkable route from a to b ([x, z]) around the obstacles: A* on a grid,
// then shortcut by line of sight and rounded. Starting or ending inside a
// footprint (standing at a bench) is allowed; the route leaves it the short way.
export function planPath(a, b, obstacles, { clearance = BODY } = {}) {
  const near = (p) => obstacles.filter((o) => boxDist(o, p[0], p[1]) < clearance);
  const ignore = new Set([...near(a), ...near(b)]);
  const obs = obstacles.filter((o) => !ignore.has(o));
  const blocked = (x, z) => obs.some((o) => boxDist(o, x, z) < clearance);
  const clear = (p, q) => {
    const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (CELL / 2));
    for (let i = 1; i < n; i++) if (blocked(p[0] + (q[0] - p[0]) * i / n, p[1] + (q[1] - p[1]) * i / n)) return false;
    return true;
  };
  if (clear(a, b)) return [a, b];

  const pad = 6;
  const minX = Math.min(a[0], b[0]) - pad, minZ = Math.min(a[1], b[1]) - pad;
  const W = Math.ceil((Math.abs(a[0] - b[0]) + 2 * pad) / CELL) + 1, H = Math.ceil((Math.abs(a[1] - b[1]) + 2 * pad) / CELL) + 1;
  const idx = (i, j) => j * W + i;
  const pos = (k) => [minX + (k % W) * CELL, minZ + Math.floor(k / W) * CELL];
  const cellOf = (p) => idx(Math.round((p[0] - minX) / CELL), Math.round((p[1] - minZ) / CELL));
  const wall = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) { const p = pos(k); wall[k] = blocked(p[0], p[1]) ? 1 : 0; }
  const s = cellOf(a), g = cellOf(b);
  wall[s] = 0; wall[g] = 0;

  const gScore = new Float32Array(W * H).fill(Infinity), from = new Int32Array(W * H).fill(-1);
  const hOf = (k) => { const dx = Math.abs((k % W) - (g % W)), dz = Math.abs(Math.floor(k / W) - Math.floor(g / W)); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
  const open = [[hOf(s), s]]; // a small binary heap
  const push = (e) => { open.push(e); let i = open.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (open[p][0] <= open[i][0]) break; [open[p], open[i]] = [open[i], open[p]]; i = p; } };
  const pop = () => { const top = open[0], last = open.pop(); if (open.length) { open[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === i) break; [open[m], open[i]] = [open[i], open[m]]; i = m; } } return top; };
  gScore[s] = 0;
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  let found = false;
  while (open.length) {
    const [, k] = pop();
    if (k === g) { found = true; break; }
    const i = k % W, j = Math.floor(k / W);
    for (const [di, dj, cost] of steps) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const n = idx(ni, nj);
      if (wall[n] || (di && dj && (wall[idx(i + di, j)] || wall[idx(i, j + dj)]))) continue;
      const t = gScore[k] + cost;
      if (t < gScore[n]) { gScore[n] = t; from[n] = k; push([t + hOf(n), n]); }
    }
  }
  if (!found) return [a, b];
  const cells = [];
  for (let k = g; k !== -1; k = from[k]) cells.push(pos(k));
  cells.reverse();
  cells[0] = a; cells[cells.length - 1] = b;
  // Shortcut: keep a point only when the straight line to the next kept one is blocked.
  const pts = [a];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !clear(cells[i], cells[j])) j--;
    pts.push(cells[j]);
    i = j;
  }
  return roundCorners(pts);
}

// Chaikin corner cutting, endpoints kept: a few passes give gentle turns.
function roundCorners(pts, passes = 3) {
  for (let p = 0; p < passes && pts.length > 2; p++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      if (i > 0) out.push([0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz]);
      if (i < pts.length - 2) out.push([0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz]);
    }
    out.push(pts.at(-1));
    pts = out;
  }
  return pts;
}

export const pathLength = (pts) => pts.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

// Point and unit tangent at arc length d (extrapolated past both ends).
function along(pts, cum, d) {
  let i = 0;
  while (i < pts.length - 2 && cum[i + 1] < d) i++;
  const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
  const L = Math.max(cum[i + 1] - cum[i], 1e-6), tx = (bx - ax) / L, tz = (bz - az) / L;
  const u = d - cum[i];
  return { x: ax + tx * u, z: az + tz * u, tx, tz };
}

// Bend a locomotion clip (it travels in a straight line) onto `path`: each
// point keeps its distance along the travel and its sideways offset, measured
// along the path instead, and each frame turns with the path's tangent. A
// planted foot stays planted. The stride is scaled so the clip ends at the end
// of the path (`scale` in the result).
export function warpToPath(src, path) {
  const clip = src.clone();
  const L = clip.frames - 1;
  const p0 = [clip.hips[0], clip.hips[2]];
  let ux = clip.hips[L * 3] - p0[0], uz = clip.hips[L * 3 + 2] - p0[1];
  const D = Math.hypot(ux, uz) || 1;
  ux /= D; uz /= D;
  const vx = uz, vz = -ux; // sideways (right of travel)
  const total = pathLength(path), k = total / D;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const base = Math.atan2(ux, uz);

  // Heading per frame from the path tangent at the hips, smoothed over 0.4 s.
  const yaw = new Float64Array(clip.frames);
  for (let f = 0; f < clip.frames; f++) {
    const s = ((clip.hips[f * 3] - p0[0]) * ux + (clip.hips[f * 3 + 2] - p0[1]) * uz) * k;
    const t = along(path, cum, s);
    yaw[f] = Math.atan2(t.tx, t.tz) - base;
  }
  const sy = smoothSeries(unwrap(yaw), 0.4 * clip.fps);

  const map = (arr, f) => {
    const dx = arr[f * 3] - p0[0], dz = arr[f * 3 + 2] - p0[1];
    const s = (dx * ux + dz * uz) * k, l = dx * vx + dz * vz;
    const t = along(path, cum, s);
    arr[f * 3] = t.x + l * t.tz;
    arr[f * 3 + 2] = t.z - l * t.tx;
  };
  const B = clip.bones.length * 4;
  for (let f = 0; f < clip.frames; f++) {
    for (const arr of [clip.hips, clip.feet.left, clip.feet.right]) map(arr, f);
    const turn = _q.setFromAxisAngle(Y, sy[f]).clone();
    for (let i = f * B; i < f * B + B; i += 4) _q.fromArray(clip.rot, i).premultiply(turn).toArray(clip.rot, i);
  }
  clip.scale = k;
  return plantFeet(clip);
}

// The locomotion clip whose own distance best fits the path (least stride change).
export function pickVariant(variants, length) {
  let best = variants[0], score = Infinity;
  for (const c of variants) {
    const L = c.frames - 1, d = Math.hypot(c.hips[L * 3] - c.hips[0], c.hips[L * 3 + 2] - c.hips[2]);
    const sc = Math.abs(Math.log(Math.max(length, 0.2) / Math.max(d, 0.2)));
    if (sc < score) { score = sc; best = c; }
  }
  return best;
}

// Where to stop to talk to (or wave at) someone at `who`: `dist` from them,
// with no prop between the two (the same side of the bench), clear of props,
// and the shortest walk from `at` among those spots.
export function talkSpot(at, who, obstacles, { dist = 1.3 } = {}) {
  const free = (p) => obstacles.every((o) => boxDist(o, p[0], p[1]) >= BODY);
  const sees = (p) => {
    for (let i = 1; i < 12; i++) {
      const x = p[0] + (who[0] - p[0]) * i / 12, z = p[1] + (who[1] - p[1]) * i / 12;
      if (obstacles.some((o) => boxDist(o, x, z) < 0.05)) return false;
    }
    return true;
  };
  let best = null, bestLen = Infinity;
  for (let a = 0; a < 360; a += 20) {
    const r = a * Math.PI / 180, p = [who[0] + Math.sin(r) * dist, who[1] + Math.cos(r) * dist];
    if (!free(p) || !sees(p)) continue;
    // A cheap lower bound first, then the real path for the promising ones.
    if (Math.hypot(p[0] - at[0], p[1] - at[1]) >= bestLen) continue;
    const len = pathLength(planPath(at, p, obstacles));
    if (len < bestLen) { bestLen = len; best = p; }
  }
  return best;
}

// ---- seats ----------------------------------------------------------------------

// Where seated hips go on each kind of seat, in the prop's own frame: which
// local axis is its front, how far along its length people can sit (half),
// and the hips' offset from the center toward the front (negative: toward the
// backrest). Anything else tagged "seat" sits at its center, front +z.
const SEAT_SPEC = {
  bench: { front: [-1, 0], half: 0.6, back: 0 },
  stump: { front: [0, 1], half: 0, back: 0 },
  chair: { front: [0, 1], half: 0, back: -0.07 },
  armchair: { front: [0, 1], half: 0, back: 0.02, solid: true },
  sofa: { front: [0, 1], half: 0.55, back: 0.02, solid: true },
};

// The set's seats in world space: [{ key, c: [x, z], front: [x, z], half, back, solid }]
// (solid: a high, closed back that hides whoever sits there from behind).
export function seatsFromSet(set) {
  const out = [];
  for (const obj of set?.children ?? []) {
    const e = obj.userData?.prop;
    if (!e || !(e.tags ?? []).includes('seat')) continue;
    const spec = SEAT_SPEC[e.id] ?? { front: [0, 1], half: 0, back: 0 };
    const r = obj.rotation.y, c = Math.cos(r), s = Math.sin(r), k = obj.scale.x;
    const [lx, lz] = spec.front;
    out.push({
      key: obj.name, c: [obj.position.x, obj.position.z],
      front: [lx * c + lz * s, -lx * s + lz * c], half: spec.half * k, back: spec.back * k, solid: !!spec.solid,
    });
  }
  return out;
}

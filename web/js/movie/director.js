// The director: turns a character's beats (one retargeted clip each) into one
// continuous clip on the film's clock, using merge.js for the joins.
//
// Every clip starts at the origin facing +Z (retarget.js normalizes them), and
// the character's group stays at the origin, so the merged clip is in world
// coordinates. That lets the camera follow it and other beats face it.
import { Clip } from '../characters/clip.js';
import { mergeClips, plantFeet, meanHeading } from '../characters/merge.js';

const RAD = Math.PI / 180;
const angleTo = (from, to) => Math.atan2(to[0] - from[0], to[1] - from[1]);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const STRETCH = [0.65, 1.35];

// A target (prop key, cast id or [x, z]) → [x, z] at film time t.
export function makeResolver(script, rows = {}) {
  const props = new Map(script.props.map((p) => [p.key, p.position]));
  const cast = new Map(script.cast.map((c) => [c.id, c.start.position]));
  return (target, t = 0) => {
    if (Array.isArray(target)) return target;
    if (props.has(target)) return props.get(target);
    if (rows[target]) return rows[target].positionAt(t);
    if (cast.has(target)) return cast.get(target);
    throw new Error(`unknown target "${target}"`);
  };
}

function slice(clip, frames) {
  if (frames >= clip.frames) return clip;
  const c = Clip.like(clip, frames);
  for (let f = 0; f < frames; f++) c.copyFrame(f, clip, f);
  c.segments = [{ name: clip.name, start: 0, end: frames }];
  return c;
}

// Hold the last pose for `frames` more frames (a gap between beats).
function hold(clip, frames) {
  if (frames <= 0) return clip;
  const c = Clip.like(clip, clip.frames + frames, clip.name);
  for (let f = 0; f < clip.frames; f++) c.copyFrame(f, clip, f);
  for (let f = clip.frames; f < c.frames; f++) c.copyFrame(f, clip, clip.frames - 1);
  c.segments = clip.segments.map((s) => ({ ...s }));
  c.segments.at(-1).end = c.frames;
  c.blends = clip.blends?.map((b) => ({ ...b }));
  return c;
}

// The ground direction a clip travels in, relative to its starting heading,
// and how far (meters). A clip that stays put has no direction.
function travel(clip, n) {
  const dx = clip.hips[(clip.frames - 1) * 3] - clip.hips[0];
  const dz = clip.hips[(clip.frames - 1) * 3 + 2] - clip.hips[2];
  const dist = Math.hypot(dx, dz);
  return { dist, angle: dist > 0.3 ? Math.atan2(dx, dz) - meanHeading(clip, 0, n) : 0 };
}

// Scale the ground path of frames [from, end) about frame `from`'s hips, so
// the last frame ends at `dest`. Positions only: no rotation, so no pop.
function stretchTail(clip, from, dest) {
  const px = clip.hips[from * 3], pz = clip.hips[from * 3 + 2];
  const L = clip.frames - 1;
  const d = Math.hypot(clip.hips[L * 3] - px, clip.hips[L * 3 + 2] - pz);
  if (d < 0.3) return 1;
  const s = Math.min(STRETCH[1], Math.max(STRETCH[0], Math.hypot(dest[0] - px, dest[1] - pz) / d));
  for (const arr of [clip.hips, clip.feet.left, clip.feet.right]) {
    for (let f = from; f < clip.frames; f++) {
      arr[f * 3] = px + (arr[f * 3] - px) * s;
      arr[f * 3 + 2] = pz + (arr[f * 3 + 2] - pz) * s;
    }
  }
  return s;
}

// One timeline row. `clips` maps beat id → retargeted Clip (origin, +Z).
// → { castId, offset, clip, beats: [{ beat, start, end, stretch }], positionAt(t) }
// A scaled character (a kid) lives in its group's space: world / scale.
export function buildRow(castEntry, beats, clips, resolveWorld, { blend = 0.3 } = {}) {
  const k = castEntry.scale ?? 1;
  const resolve = (target, t) => resolveWorld(target, t).map((v) => v / k);
  const fps = clips.get(beats[0].id).fps;
  const offset = beats[0].start;
  let acc = null;
  const placed = [];

  for (const beat of beats) {
    // Fallback library clips can be longer than the beat: cut them.
    let c = slice(clips.get(beat.id), Math.round(beat.duration * fps) + 1);
    const n = Math.max(1, Math.min(Math.round(blend * fps), c.frames - 1));
    const tr = travel(c, n);

    if (!acc) {
      const from = castEntry.start.position.map((v) => v / k);
      let heading = (castEntry.start.facing ?? 0) * RAD;
      if (typeof beat.facing === 'number') heading = beat.facing * RAD;
      else if (beat.facing !== undefined) heading = angleTo(from, resolve(beat.facing, beat.start));
      if (beat.to !== undefined && tr.dist > 0.3) heading = angleTo(from, resolve(beat.to, beat.start)) - tr.angle;
      acc = plantFeet(c.clone().transform(heading - meanHeading(c, 0, n), [c.hips[0], c.hips[2]], [from[0] - c.hips[0], from[1] - c.hips[2]]));
      const stretch = beat.to !== undefined ? stretchTail(acc, 0, resolve(beat.to, beat.start)) : 1;
      placed.push({ beat, start: offset, end: offset + acc.duration, stretch });
      continue;
    }

    // Wait for the planned start if the previous clip ended early.
    const end = offset + acc.duration;
    acc = hold(acc, Math.round((beat.start - end) * fps));

    const start = acc.frames - n; // where the join begins, and where B's frame 0 lands
    const at = [acc.hips[start * 3], acc.hips[start * 3 + 2]];
    const tJoin = offset + start / fps;
    const current = meanHeading(acc, start, acc.frames);
    let heading;
    if (typeof beat.facing === 'number') heading = beat.facing * RAD;
    else if (beat.facing !== undefined) heading = angleTo(at, resolve(beat.facing, tJoin));
    if (beat.to !== undefined && tr.dist > 0.3) heading = angleTo(at, resolve(beat.to, tJoin)) - tr.angle;
    // Big turns get a longer blend so the character pivots instead of snapping.
    const turn = heading === undefined ? 0 : Math.abs(wrap(heading - current));
    const b = blend + 0.5 * turn / Math.PI;
    acc = mergeClips(acc, c, { blend: b, heading: heading === undefined ? undefined : current + wrap(heading - current) });
    const seg = acc.segments.at(-1);
    const stretch = beat.to !== undefined ? stretchTail(acc, seg.start, resolve(beat.to, tJoin)) : 1;
    placed.push({ beat, start: offset + seg.start / fps, end: offset + acc.duration, stretch });
  }
  for (let i = 0; i < placed.length - 1; i++) placed[i].end = placed[i + 1].start;

  const clip = acc;
  return {
    castId: castEntry.id,
    scale: k,
    offset,
    clip,
    beats: placed,
    end: offset + clip.duration,
    positionAt(t) {
      const f = Math.max(0, Math.min(clip.frames - 1, Math.round((t - offset) * fps)));
      return [clip.hips[f * 3] * k, clip.hips[f * 3 + 2] * k];
    },
  };
}

// All rows. Two passes, so a beat that faces another character uses where
// that character really is at that moment, not where it started.
export function direct(script, clipsByCast, opts) {
  let rows = {};
  for (let pass = 0; pass < 2; pass++) {
    const resolve = makeResolver(script, rows);
    const next = {};
    for (const c of script.cast) {
      const beats = script.beats.filter((b) => b.cast === c.id).sort((a, b) => a.start - b.start);
      if (beats.length) next[c.id] = buildRow(c, beats, clipsByCast[c.id], resolve, opts);
    }
    rows = next;
  }
  return rows;
}

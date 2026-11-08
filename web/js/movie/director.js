// The director: turns a character's beats (one retargeted clip each) into one
// continuous clip on the film's clock, using merge.js for the joins.
//
// Every clip starts at the origin facing +Z (retarget.js normalizes them), and
// the character's group stays at the origin, so the merged clip is in world
// coordinates. That lets the camera follow it and other beats face it.
import { Clip } from '../characters/clip.js';
import { mergeClips, plantFeet, meanHeading } from '../characters/merge.js';
import { planPath, warpToPath, pickVariant, pathLength, talkSpot } from './control.js';

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

// Seated beats (sitting down on a bench or chair, and the seated idle, talk or
// gestures after it) end with the hips on the seat: Kimodo's sit-down steps
// back by its own amount (0.1-0.45 m) and the seated loops don't step at all,
// so without this a sitter floats in front of the seat. The correction fades
// in as the hips go down (a sit-down) or applies whole (already seated), and
// the next beats start from the corrected spot, so a stand-up rises off the seat.
// `seats`: [{ key, c: [x, z], front: [x, z], half, back }] (see seatsFromSet).
const SIT_DOWN = /^sit_(bench|chair)$/;
const SEATED = /^sit_(bench|chair)_(idle|talk)$/;
const SITS = /^a person sits\b(?!.*\b(ground|floor|grass|sand|rug|blanket)\b)/i;
function isSeated(beat) {
  if (beat.motion) return SIT_DOWN.test(beat.motion) || SEATED.test(beat.motion) || (/^live|^$/.test(beat.motion) && SITS.test(beat.prompt));
  return SITS.test(beat.prompt ?? '') && !/stands? up|gets? up|rises/i.test(beat.prompt ?? '');
}
function snapSeat(clip, from, beat, seats) {
  if (!seats.length || !isSeated(beat) || from >= clip.frames - 1) return null;
  const L = clip.frames - 1;
  const end = [clip.hips[L * 3], clip.hips[L * 3 + 2]];
  let best = null, bd = 1.3;
  for (const s of seats) {
    // Distance to the seat's line (a bench or sofa seats several along it).
    const side = [-s.front[1], s.front[0]];
    const a = Math.max(-s.half, Math.min(s.half, (end[0] - s.c[0]) * side[0] + (end[1] - s.c[1]) * side[1]));
    const p = [s.c[0] + s.front[0] * s.back + side[0] * a, s.c[1] + s.front[1] * s.back + side[1] * a];
    const d = Math.hypot(end[0] - p[0], end[1] - p[1]);
    if (d < bd) { bd = d; best = { s, p }; }
  }
  if (!best) return null;
  const dx = best.p[0] - end[0], dz = best.p[1] - end[1];
  const sitDown = SIT_DOWN.test(beat.motion ?? '') || (!SEATED.test(beat.motion ?? '') && /sits? down|sits on|takes a seat/i.test(beat.prompt ?? ''));
  const y0 = clip.hips[from * 3 + 1], y1 = clip.hips[L * 3 + 1];
  for (let f = from; f <= L; f++) {
    let w = 1;
    if (sitDown) {
      const u = y0 - y1 > 0.08 ? (y0 - clip.hips[f * 3 + 1]) / (y0 - y1) : (f - from) / Math.max(1, L - from);
      w = Math.min(1, Math.max(0, u));
      w = w * w * (3 - 2 * w);
    }
    for (const arr of [clip.hips, clip.feet.left, clip.feet.right]) {
      arr[f * 3] += dx * w;
      arr[f * 3 + 2] += dz * w;
    }
  }
  return { key: best.s.key, moved: +Math.hypot(dx, dz).toFixed(2) };
}

// One timeline row. `clips` maps beat id → retargeted Clip (origin, +Z).
// → { castId, offset, clip, beats: [{ beat, start, end, stretch }], positionAt(t) }
// A scaled character (a kid) lives in its group's space: world / scale.
export function buildRow(castEntry, beats, clips, resolveWorld, { blend = 0.3, obstacles = [], seats = [] } = {}) {
  const k = castEntry.scale ?? 1;
  const resolve = (target, t) => resolveWorld(target, t).map((v) => v / k);
  const clipOf = (e) => e.clip ?? e;
  const fps = clipOf(clips.get(beats[0].id)).fps;
  const offset = beats[0].start;
  // Obstacles in this character's group space (world / scale).
  const obs = obstacles.map((o) => ({ ...o, c: [o.c[0] / k, o.c[1] / k], h: [o.h[0] / k, o.h[1] / k] }));
  const seatsK = seats.map((s) => ({ ...s, c: [s.c[0] / k, s.c[1] / k], half: s.half / k, back: s.back / k }));
  let acc = null;
  const placed = [];

  for (const beat of beats) {
    const entry = clips.get(beat.id);
    const act = entry instanceof Clip ? null : entry;
    const n0 = Math.max(1, Math.round(blend * fps));
    // Where this beat starts: the join point of the previous clip (or the cast start).
    if (acc) acc = hold(acc, Math.round((beat.start - (offset + acc.duration)) * fps));
    const joinAt = acc ? acc.frames - n0 : 0;
    const at = acc ? [acc.hips[joinAt * 3], acc.hips[joinAt * 3 + 2]] : castEntry.start.position.map((v) => v / k);
    const tJoin = acc ? offset + joinAt / fps : beat.start;

    // Locomotion from the library: a path around the props, the clip bent onto it.
    if (act?.root === 'path' && beat.to !== undefined) {
      let goal = resolve(beat.to, tJoin);
      // Walking up to someone to greet or talk: stop at talking distance, same side of any prop.
      if (beat.approach) goal = talkSpot(at, resolve(beat.approach, beat.start + beat.duration), obs, { dist: 1.3 / k }) ?? goal;
      const path = planPath(at, goal, obs);
      const len = pathLength(path);
      let c = pickVariant(act.variants, len).clone();
      // Retargeted clips start at the origin facing +Z: put frame 0 at `at`, then bend.
      c.transform(0, [0, 0], [at[0] - c.hips[0], at[1] - c.hips[2]]);
      c = warpToPath(c, path);
      const info = `${(len * k).toFixed(1)} m${path.length > 2 ? ', around props' : ', straight'} · stride ×${c.scale.toFixed(2)}`;
      if (!acc) {
        acc = plantFeet(c.clone());
        placed.push({ beat, start: offset, end: offset + acc.duration, stretch: c.scale, path, pathInfo: info });
      } else {
        const n = Math.max(1, Math.min(n0, c.frames - 1));
        const current = meanHeading(acc, joinAt, acc.frames);
        const heading = meanHeading(c, 0, n);
        const b = blend + 0.5 * Math.abs(wrap(heading - current)) / Math.PI;
        acc = mergeClips(acc, c, { blend: b, heading });
        const seg = acc.segments.at(-1);
        placed.push({ beat, start: offset + seg.start / fps, end: offset + acc.duration, stretch: c.scale, path, pathInfo: info });
      }
      continue;
    }

    // Fallback library clips can be longer than the beat: cut them (not a sit or a stand-up).
    let c = slice(clipOf(entry), Math.max(act?.minFrames ?? 1, Math.round(beat.duration * fps) + 1));
    const n = Math.max(1, Math.min(n0, c.frames - 1));
    const tr = act?.root === 'pinned' ? { dist: 0, angle: 0 } : travel(c, n);

    if (!acc) {
      const from = at;
      let heading = (castEntry.start.facing ?? 0) * RAD;
      if (typeof beat.facing === 'number') heading = beat.facing * RAD;
      else if (beat.facing !== undefined) heading = angleTo(from, resolve(beat.facing, beat.start));
      if (beat.to !== undefined && tr.dist > 0.3) heading = angleTo(from, resolve(beat.to, beat.start)) - tr.angle;
      acc = plantFeet(c.clone().transform(heading - meanHeading(c, 0, n), [c.hips[0], c.hips[2]], [from[0] - c.hips[0], from[1] - c.hips[2]]));
      const stretch = beat.to !== undefined && !act ? stretchTail(acc, 0, resolve(beat.to, beat.start)) : 1;
      const seat = snapSeat(acc, 0, beat, seatsK);
      placed.push({ beat, start: offset, end: offset + acc.duration, stretch, ...(seat ? { seat } : {}) });
      continue;
    }

    const current = meanHeading(acc, joinAt, acc.frames);
    let heading;
    if (typeof beat.facing === 'number') heading = beat.facing * RAD;
    else if (beat.facing !== undefined) heading = angleTo(at, resolve(beat.facing, tJoin));
    if (beat.to !== undefined && tr.dist > 0.3) heading = angleTo(at, resolve(beat.to, tJoin)) - tr.angle;
    // Big turns get a longer blend so the character pivots instead of snapping.
    const turn = heading === undefined ? 0 : Math.abs(wrap(heading - current));
    const b = blend + 0.5 * turn / Math.PI;
    acc = mergeClips(acc, c, { blend: b, heading: heading === undefined ? undefined : current + wrap(heading - current) });
    const seg = acc.segments.at(-1);
    const stretch = beat.to !== undefined && !act ? stretchTail(acc, seg.start, resolve(beat.to, tJoin)) : 1;
    const seat = snapSeat(acc, seg.start, beat, seatsK);
    placed.push({ beat, start: offset + seg.start / fps, end: offset + acc.duration, stretch, ...(seat ? { seat } : {}) });
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

// Gestures aimed at someone: a wave, a talk, a point (library or live).
const GESTURE_MOTION = /^(wave|talk|point|laugh|sit_bench_talk)$/;
const STANDING_REACT = /^(idle|talk|wave|point|laugh)$/;
const isGesture = (b) => GESTURE_MOTION.test(b.motion ?? '') || (!b.motion && /\b(waves?|points?|talks?|tells|says|greets?)\b/i.test(b.prompt));

// Who a gesture is for: its target if that's a character, else the character
// nearest the target (grandpa in the rowboat, the girl at her window), else
// the nearest other character if it has no target.
function addressee(b, script, resolve) {
  const others = script.cast.filter((c) => c.id !== b.cast);
  if (!others.length) return null;
  if (others.some((c) => c.id === b.facing)) return b.facing;
  const me = resolve(b.cast, b.start);
  const p = b.facing === undefined || typeof b.facing === 'number' ? me : resolve(b.facing, b.start);
  let best = null, bd = Infinity;
  for (const c of others) {
    const d = Math.hypot(...resolve(c.id, b.start).map((v, i) => v - p[i]));
    if (d < bd) { bd = d; best = c.id; }
  }
  return b.facing === undefined || typeof b.facing === 'number' || bd < 3.5 ? best : null;
}

// Attention: each gesture faces the one it's for, and that one, if standing
// and not busy, turns back to face the gesturer (at the moment of the gesture).
const FILLS = /^(idle|talk|sit_bench_idle|sit_ground_idle|sit_bench_talk|sit_bench|sit_ground)$/;
export function aimGestures(script, resolve, shift = {}) {
  const beats = script.beats.map((b) => ({ ...b, start: shift[b.id] ?? b.start }));
  // A beat that now starts later stretches the in-place beat before it (an idle keeps breathing).
  for (const c of script.cast) {
    const mine = beats.filter((b) => b.cast === c.id).sort((a, b) => a.start - b.start);
    for (let i = 0; i < mine.length - 1; i++) {
      const gap = mine[i + 1].start - (mine[i].start + mine[i].duration);
      if (gap > 0.05 && FILLS.test(mine[i].motion ?? '')) mine[i].duration += gap;
    }
  }
  const LOCO = /^(walk|run|crouch_walk)$/;
  for (const g of beats.filter(isGesture)) {
    if (typeof g.facing === 'number' && !GESTURE_MOTION.test(g.motion ?? '')) continue;
    const who = addressee(g, script, resolve);
    if (!who) continue;
    g.facing = who;
    // The walk right before it ends next to them, not at a place.
    const prev = beats.filter((b) => b.cast === g.cast && b.start < g.start).sort((a, b) => a.start - b.start).at(-1);
    if (prev && LOCO.test(prev.motion ?? '') && prev.to !== undefined) prev.approach = who;
    const mine = beats.filter((b) => b.cast === who).sort((a, b) => a.start - b.start);
    const bb = mine.findLast((b) => b.start <= g.start + 0.5) ?? mine[0];
    if (!bb || bb === g || bb.to !== undefined) continue;
    if (!(STANDING_REACT.test(bb.motion ?? '') || (!bb.motion && isGesture(bb)))) continue;
    bb.facing = isGesture(bb) ? g.cast : resolve(g.cast, g.start + 0.3);
  }
  return { ...script, beats };
}

// All rows. Passes, so a beat that faces another character uses where that
// character really is at that moment, not where it started; gestures are aimed
// once positions are known.
export function direct(script, clipsByCast, opts) {
  let rows = {};
  const shift = {};
  for (let pass = 0; pass < 4; pass++) {
    const resolve = makeResolver(script, rows);
    const aimed = aimGestures(script, resolve, shift);
    const next = {};
    for (const c of script.cast) {
      const beats = aimed.beats.filter((b) => b.cast === c.id).sort((a, b) => a.start - b.start);
      if (beats.length) next[c.id] = buildRow(c, beats, clipsByCast[c.id], resolve, opts);
    }
    rows = next;
    if (!syncReactions(script, aimed, rows, shift)) break;
  }
  return rows;
}

// "She waves back": a gesture answering another one starts 0.6 s after the one it
// answers really starts (walks take as long as their paths, so planned times drift).
// Returns true if any start moved.
export function syncReactions(script, aimed, rows, shift) {
  const actual = {};
  for (const r of Object.values(rows)) for (const p of r.beats) actual[p.beat.id] = p.start;
  const order = new Map(script.beats.map((b, i) => [b.id, i]));
  let moved = false;
  for (const b of aimed.beats.filter(isGesture)) {
    const g = aimed.beats.find((x) => x.cast === b.facing && isGesture(x) && x.facing === b.cast &&
      Math.abs(x.start - b.start) < 2.5 && (x.start < b.start - 0.05 ||
        (Math.abs(x.start - b.start) <= 0.05 && (/\bback\b/.test(b.action ?? '') || order.get(x.id) < order.get(b.id)))));
    if (!g || actual[g.id] === undefined) continue;
    // Starts here include the turn blend, so correct by the difference.
    const err = actual[g.id] + 0.6 - (actual[b.id] ?? b.start);
    if (Math.abs(err) > 0.1) {
      shift[b.id] = b.start + err;
      moved = true;
    }
  }
  return moved;
}

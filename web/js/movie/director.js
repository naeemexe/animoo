// The director: turns a character's beats (one retargeted clip each) into one
// continuous clip on the film's clock, using merge.js for the joins.
//
// Every clip starts at the origin facing +Z (retarget.js normalizes them), and
// the character's group stays at the origin, so the merged clip is in world
// coordinates. That lets the camera follow it and other beats face it.
import * as THREE from 'three';
import { Clip } from '../characters/clip.js';
import { mergeClips, plantFeet, meanHeading } from '../characters/merge.js';
import { planPath, warpToPath, pickVariant, pathLength, talkSpot, lineClear, pushOut } from './control.js';

const RAD = Math.PI / 180;
const angleTo = (from, to) => Math.atan2(to[0] - from[0], to[1] - from[1]);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const STRETCH = [0.65, 1.35];

// A target (prop key, cast id or [x, z]) → [x, z] at film time t.
export function makeResolver(script, rows = {}) {
  const props = new Map(script.props.map((p) => [p.key, p.position]));
  // A prop deleted in edit mode: things that faced it face where it was.
  for (const p of script.layout_props ?? []) if (!props.has(p.key)) props.set(p.key, p.position);
  const cast = new Map(script.cast.map((c) => [c.id, c.start.position]));
  return (target, t = 0) => {
    if (Array.isArray(target)) return target;
    if (props.has(target)) return props.get(target);
    if (rows[target]) return rows[target].positionAt(t);
    if (cast.has(target)) return cast.get(target);
    throw new Error(`unknown target "${target}"`);
  };
}

// ---- beats follow their props (task 31) ----------------------------------------

// Beat spots are coordinates the layout placed around its props (`layout_props`).
// After edit mode moved, turned or scaled a prop, each spot within 2.5 m of it
// (the nearest prop wins) moves with it rigidly, and a character's facing turns
// with the prop its current spot belongs to. A deleted prop leaves its spots.
// Nothing moved: the script comes back unchanged.
const WALKABLE = /flower|grass|lily|mushroom|pebble|path|rug/;
export function followProps(script) {
  const before = (script.layout_props ?? []).filter((p) => !WALKABLE.test(`${p.library ?? ''} ${p.key}`));
  const now = new Map(script.props.map((p) => [p.key, p]));
  const moved = (p, q) => q && (Math.hypot(q.position[0] - p.position[0], q.position[1] - p.position[1]) > 0.005 ||
    Math.abs((q.rotation ?? 0) - (p.rotation ?? 0)) > 0.1 || Math.abs((q.scale ?? 1) - (p.scale ?? 1)) > 0.001);
  if (!before.some((p) => moved(p, now.get(p.key)))) return script;
  const follow = (pt) => {
    let best = null, bd = 2.5;
    for (const p of before) {
      const d = Math.hypot(pt[0] - p.position[0], pt[1] - p.position[1]);
      if (d < bd) { bd = d; best = p; }
    }
    const q = best && now.get(best.key);
    if (!q || !moved(best, q)) return { p: pt, turn: 0, key: null };
    const turn = (q.rotation ?? 0) - (best.rotation ?? 0), r = turn * RAD, c = Math.cos(r), sn = Math.sin(r);
    const ks = (q.scale ?? 1) / (best.scale ?? 1);
    const x = (pt[0] - best.position[0]) * ks, z = (pt[1] - best.position[1]) * ks;
    return { p: [+(q.position[0] + c * x + sn * z).toFixed(3), +(q.position[1] - sn * x + c * z).toFixed(3)], turn, key: best.key };
  };
  const notes = [];
  const turnOf = {};
  const cast = script.cast.map((c) => {
    const f = follow(c.start.position);
    turnOf[c.id] = f.turn;
    if (!f.key) return c;
    notes.push(`${c.id} start → ${f.key}`);
    return { ...c, start: { ...c.start, position: f.p, facing: (c.start.facing ?? 0) + f.turn } };
  });
  const beats = [...script.beats].sort((a, b) => a.start - b.start).map((b) => {
    const out = { ...b };
    if (Array.isArray(b.to)) {
      const f = follow(b.to);
      turnOf[b.cast] = f.turn;
      if (f.key) { out.to = f.p; notes.push(`${b.id} → ${f.key}`); }
    }
    if (typeof b.facing === 'number' && turnOf[b.cast]) out.facing = b.facing + turnOf[b.cast];
    return out;
  });
  return { ...script, cast, beats, followed: notes };
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

// A smooth curve through drawn points (centripetal Catmull-Rom, no overshoot):
// the walk passes through every node the user placed.
export function roundCorners(pts, per = 10) {
  if (pts.length < 3) return pts;
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  return curve.getPoints((pts.length - 1) * per).map((v) => [v.x, v.z]);
}

// A drawn path kept clear of props (task 31), in node order: a node inside a
// footprint moves out to the nearest free spot, and a stretch of the curve
// between two nodes that cuts a footprint is replaced by an A* route between
// them. A path with nothing in the way is the plain curve.
export function nudgeDrawn(at, nodes, obstacles) {
  const all = [at, ...nodes.map((p) => pushOut(p, obstacles))];
  const per = 10, curve = roundCorners(all, per);
  const out = [at];
  for (let i = 0; i < all.length - 1; i++) {
    const seg = all.length < 3 ? all : curve.slice(i * per, (i + 1) * per + 1);
    out.push(...(lineClear(seg, obstacles) ? seg : planPath(all[i], all[i + 1], obstacles)).slice(1));
  }
  return { path: out, nudged: all.slice(1).filter((p, i) => p !== nodes[i]).length };
}

// Bodies are capsules (0.25 m around the hips' line), so two people closer
// than 0.7 m (hips to hips) touch. `others`: [{ row, yields }] for the other
// characters; one that yields (later in the cast list) is ignored while it is
// itself walking, so two walkers don't both swerve. → where the others stand
// when `posAt(t)` runs into them, between t0 and t1 (not right at the ends).
const TOUCH = 0.7;
const walkingAt = (row, t) => row.beats.some((p) => p.path && t >= p.start && t < p.end);
export function bodiesHit(posAt, t0, t1, others, ends = []) {
  const hits = [];
  for (let t = t0 + 0.3; t < t1; t += 0.1) {
    const p = posAt(t);
    for (const o of others) {
      if (o.yields && walkingAt(o.row, t)) continue;
      const q = o.row.positionAt(t);
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= TOUCH) continue;
      if (ends.some((e) => Math.hypot(e[0] - q[0], e[1] - q[1]) < TOUCH)) continue;
      if (!hits.some((h) => Math.hypot(h[0] - q[0], h[1] - q[1]) < 0.3)) hits.push(q);
    }
  }
  return hits;
}

// One timeline row. `clips` maps beat id → retargeted Clip (origin, +Z).
// → { castId, offset, clip, beats: [{ beat, start, end, stretch }], positionAt(t) }
// A scaled character (a kid) lives in its group's space: world / scale.
export function buildRow(castEntry, beats, clips, resolveWorld, { blend = 0.3, obstacles = [], seats = [], walks = {}, others = [] } = {}) {
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
      // A path drawn in edit mode (task 30) replaces the planned one: through its points, corners
      // rounded, nudged around props (task 31).
      const drawn = walks[beat.id];
      const nodes = drawn?.map((p) => [p[0] / k, p[1] / k]);
      let goal = null;
      if (!drawn?.length) {
        goal = resolve(beat.to, tJoin);
        // Walking up to someone to greet or talk: stop at talking distance, same side of any prop.
        if (beat.approach) goal = talkSpot(at, resolve(beat.approach, beat.start + beat.duration), obs, { dist: 1.3 / k }) ?? goal;
        // Not on top of someone standing there when the walk ends.
        else {
          for (const o of others) {
            const q = o.row.positionAt(beat.start + beat.duration).map((v) => v / k), d = Math.hypot(goal[0] - q[0], goal[1] - q[1]);
            if (d < TOUCH / k) goal = d > 1e-3 ? [q[0] + (goal[0] - q[0]) * TOUCH / k / d, q[1] + (goal[1] - q[1]) * TOUCH / k / d] : [q[0] + TOUCH / k, q[1]];
          }
        }
      }
      let nudged = 0;
      const route = (o) => {
        if (!nodes?.length) return planPath(at, goal, o);
        const r = nudgeDrawn(at, nodes, o);
        nudged = r.nudged;
        return r.path;
      };
      const walkOn = (path) => {
        const len = pathLength(path);
        let c = pickVariant(act.variants, len).clone();
        // A drawn path can be much longer than any walk clip: chain the walk, so the stride stays natural.
        if (drawn?.length) {
          const base = c, reach = (x) => Math.hypot(x.hips[(x.frames - 1) * 3] - x.hips[0], x.hips[(x.frames - 1) * 3 + 2] - x.hips[2]);
          for (let i = 0; i < 4 && len / Math.max(reach(c), 0.5) > 1.3; i++) c = mergeClips(c, base, { blend: 0.6 });
          c.segments = [{ name: base.name, start: 0, end: c.frames }]; // one beat on the timeline
        }
        // Retargeted clips start at the origin facing +Z: put frame 0 at `at`, then bend.
        c.transform(0, [0, 0], [at[0] - c.hips[0], at[1] - c.hips[2]]);
        return warpToPath(c, path);
      };
      let path = route(obs), c = walkOn(path), len = pathLength(path), gaveWay = 0;
      // Other characters (task 31): where this walk would run into someone at that moment,
      // that spot becomes an obstacle and the walk is planned again (up to 3 times).
      let obsX = obs;
      for (let i = 0; i < 3 && others.length; i++) {
        const posAt = (t) => { const f = Math.max(0, Math.min(c.frames - 1, Math.round((t - tJoin) * fps))); return [c.hips[f * 3] * k, c.hips[f * 3 + 2] * k]; };
        const hits = bodiesHit(posAt, tJoin, tJoin + c.duration, others, [at.map((v) => v * k), path.at(-1).map((v) => v * k)]);
        if (!hits.length) break;
        gaveWay += hits.length;
        obsX = obsX.concat(hits.map((q) => ({ key: 'body', c: [q[0] / k, q[1] / k], h: [0.25 / k, 0.25 / k], rot: 0 })));
        path = route(obsX); c = walkOn(path); len = pathLength(path);
      }
      const info = `${(len * k).toFixed(1)} m${drawn?.length ? `, drawn (${drawn.length} points${nudged ? `, ${nudged} moved off props` : ''})` : path.length > 2 ? ', around props' : ', straight'}${gaveWay ? ', around people' : ''} · stride ×${c.scale.toFixed(2)}`;
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
  script = followProps(script);
  let rows = {};
  const shift = {};
  const rank = new Map(script.cast.map((c, i) => [c.id, i]));
  for (let pass = 0; pass < 4; pass++) {
    const resolve = makeResolver(script, rows);
    const aimed = aimGestures(script, resolve, shift);
    const next = {};
    for (const c of script.cast) {
      const beats = aimed.beats.filter((b) => b.cast === c.id).sort((a, b) => a.start - b.start);
      // Where everyone else is (from the last pass), so walks go around them (task 31).
      const others = Object.values(rows).filter((r) => r.castId !== c.id).map((r) => ({ row: r, yields: rank.get(r.castId) > rank.get(c.id) }));
      if (beats.length) next[c.id] = buildRow(c, beats, clipsByCast[c.id], resolve, { ...opts, others });
    }
    rows = next;
    const synced = syncReactions(script, aimed, rows, shift);
    if (!synced && !(pass < 3 && collisions(script, rows, rank).length)) break;
  }
  return rows;
}

// Walks that run into another character: [{ cast, beat, at: [x, z], t }] (task 31).
export function collisions(script, rows, rank = new Map(script.cast.map((c, i) => [c.id, i]))) {
  const out = [];
  for (const r of Object.values(rows)) {
    const others = Object.values(rows).filter((o) => o.castId !== r.castId).map((o) => ({ row: o, yields: rank.get(o.castId) > rank.get(r.castId) }));
    for (const p of r.beats.filter((b) => b.path)) {
      const a = r.positionAt(p.start), b = r.positionAt(p.end);
      for (const q of bodiesHit((t) => r.positionAt(t), p.start, p.end, others, [a, b])) out.push({ cast: r.castId, beat: p.beat.id, at: q });
    }
  }
  return out;
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

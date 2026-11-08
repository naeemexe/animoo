// The director camera. After the clips are merged, `planShots()` cuts the film
// like an editor would, from the beats (rules, no LLM call): an establishing
// wide shot, then one shot per new action, each with a type (wide, medium,
// close, side, ots = over the shoulder, low) and a move (static, dolly, orbit,
// crane, track). It avoids jump cuts (a cut always changes the shot size or
// the angle by 35° or more), keeps the camera on one side of the line between
// two characters (the 180° rule), frames whoever is doing something, and
// swings the camera around props that would block the view.
import * as THREE from 'three';
import { LOOK } from '../look.js';
import { meanHeading } from '../characters/merge.js';

const RAD = Math.PI / 180;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// dist: meters from the subject; h: camera height; look: look-at height (×
// the subject's scale); blur: depth-of-field blur in px (focus is on the
// subject; none in wide shots); size: shot size for the jump-cut rule; off: the
// camera's angle off the subject's facing (degrees, to the chosen side).
export const TYPES = {
  wide: { dist: 22, h: 9, look: 0.8, blur: 0, size: 0, off: 35 },
  medium: { dist: 7.5, h: 2.4, look: 1.05, blur: 3.5, size: 1, off: 30 },
  close: { dist: 3.4, h: 1.65, look: 1.4, blur: 6, size: 2, off: 22 },
  side: { dist: 7, h: 1.3, look: 1.0, blur: 3.5, size: 1, off: 90 },
  low: { dist: 5.2, h: 0.4, look: 1.35, blur: 4.5, size: 1.5, off: 28 },
  ots: { dist: 1.9, h: 1.75, look: 1.35, blur: 6.5, size: 2, off: 0 },
};
// The old script framings map onto the new types.
const LEGACY = { wide: 'wide', medium: 'medium', close: 'close' };

const MIN_SHOT = 2.2;
const MAX_SHOT = 5.5;

const kind = (beat) => {
  const p = `${beat.action ?? ''} ${beat.prompt ?? ''}`.toLowerCase();
  if (/stands still|waits|looks around|idle/.test(p)) return 'idle';
  if (/danc|jump|celebrat|spin/.test(p)) return 'dance';
  if (/run|jog|chase|flee/.test(p)) return 'run';
  if (/walk|stroll|row/.test(p)) return 'walk';
  if (/wave|talk|tell|laugh|shout|point|hand|give|greet|story|call/.test(p)) return 'gesture';
  if (/sit|rest|fish|lie/.test(p)) return 'sit';
  return 'act';
};

const ease = (u) => u * u * (3 - 2 * u);

export class DirectorCamera {
  constructor(stage, look) {
    this.stage = stage;
    this.look = look;
    this.enabled = false;
    this.script = null;
    this.shots = null;
    this.target = new THREE.Vector3();
    this.shot = null;
  }

  setScript(script, resolve) {
    this.script = script;
    this.resolve = resolve;
    this.shots = null;
    this.shot = null;
  }

  setEnabled(on) {
    this.enabled = on;
    const c = this.stage.controls;
    c.enabled = !on;
    if (!on) {
      // Hand over to orbit controls where the director left off.
      c.minDistance = 5;
      c.target.copy(this.target);
      this.look.setFocus({ point: c.target, blur: LOOK.blur });
      if (this.stage.camera.fov !== 28) { this.stage.camera.fov = 28; this.stage.camera.updateProjectionMatrix(); }
    }
  }


  shotAt(t) {
    const shots = this.shots ?? this.script?.shots ?? [];
    return shots.find((s) => t >= s.start && t < s.start + s.duration) ?? shots.at(-1);
  }

  // ---- where things are -----------------------------------------------------
  castScale(id) {
    return this.script.cast.find((c) => c.id === id)?.scale ?? 1;
  }

  pointAt(s, t, rows) {
    if (rows[s] && t >= rows[s].offset) return rows[s].positionAt(t);
    return this.resolve(s, t);
  }

  // A character's hips height at t (meters; about 0.95 standing, 0.55
  // seated), so the framing follows a sitter down. Heights in TYPES are for
  // standing hips at 0.95 and scale with it.
  hipsAt(id, t, rows) {
    const row = rows[id];
    if (!row) return 0.95 * this.castScale(id);
    const f = Math.max(0, Math.min(row.clip.frames - 1, Math.round((t - row.offset) * row.clip.fps)));
    return Math.max(0.25, row.clip.hips[f * 3 + 1] * row.scale);
  }

  // The mean of the subjects' positions, their spread, mean scale and drop.
  subjectAt(shot, t, rows) {
    const list = [].concat(shot.subject);
    const flat = typeof list[0] === 'number' ? [list] : list;
    let x = 0, z = 0, spread = 0, k = 0;
    const pts = flat.map((s) => this.pointAt(s, t, rows));
    for (const p of pts) { x += p[0]; z += p[1]; }
    x /= pts.length; z /= pts.length;
    for (const p of pts) spread = Math.max(spread, Math.hypot(p[0] - x, p[1] - z));
    let hips = 0;
    for (const s of flat) {
      const isCast = typeof s === 'string' && this.script.cast.some((c) => c.id === s);
      k += isCast ? this.castScale(s) : 1;
      hips = Math.max(hips, isCast ? this.hipsAt(s, t, rows) : 0.95);
    }
    return { x, z, spread, k: k / flat.length, hips };
  }

  // Which way a character faces at t (radians, 0 = +z).
  facingAt(id, t, rows) {
    const row = rows[id];
    if (!row) return (this.script.cast.find((c) => c.id === id)?.start.facing ?? 0) * RAD;
    const f = Math.round((Math.max(t, row.offset) - row.offset) * row.clip.fps);
    return meanHeading(row.clip, f - 6, f + 6);
  }

  // ---- the camera for a shot at time t ---------------------------------------
  // `s` is the subject point (smoothed while playing). Returns {pos, look}.
  pose(shot, t, rows, s) {
    const T = TYPES[shot.type] ?? TYPES[LEGACY[shot.framing]] ?? TYPES.medium;
    const u = ease(THREE.MathUtils.clamp((t - shot.start) / Math.max(shot.duration, 0.01), 0, 1));
    const k = s.k ?? 1;
    const r = shot.type === 'wide' ? k : (s.hips ?? 0.95 * k) / 0.95;
    const look = new THREE.Vector3(s.x, Math.max(0.5, T.look * r), s.z);
    if (shot.type === 'ots' && shot.partner) {
      // Behind the partner's shoulder, looking at the subject's face.
      const b = this.pointAt(shot.partner, t, rows);
      let dx = b[0] - s.x, dz = b[1] - s.z;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const side = shot.side ?? 1;
      const kb = this.castScale(shot.partner);
      const back = T.dist * (1.05 - 0.1 * u);
      const rb = this.hipsAt(shot.partner, t, rows) / 0.95;
      const pos = new THREE.Vector3(b[0] + dx * back - dz * 0.55 * side, T.h * rb, b[1] + dz * back + dx * 0.55 * side);
      return { pos, look };
    }
    let dist = (shot.dist ?? T.dist) + s.spread * (shot.type === 'wide' ? 1.2 : 1.6);
    let h = shot.type === 'wide' ? T.h * Math.max(k, 0.8) + s.spread * 0.4
      : shot.type === 'low' ? T.h : Math.max(0.5, T.h * r);
    let az = shot.angle * RAD;
    switch (shot.move) {
      case 'dolly': dist *= 1.22 - 0.3 * u; break; // push in
      case 'pull': dist *= 0.9 + 0.3 * u; break; // pull out
      case 'orbit': az += (shot.orbit ?? 18) * RAD * (u - 0.5) * 2; break;
      case 'crane': h = h * (1.9 - 0.9 * u) + 2 * (1 - u); break; // crane down
      case 'rise': h = h * (1 + 0.8 * u) + 2 * u; dist *= 1 + 0.25 * u; break; // crane up and out
    }
    const flat = Math.sqrt(Math.max(dist * dist - (h - look.y) ** 2, dist * dist * 0.25));
    const pos = new THREE.Vector3(s.x + Math.sin(az) * flat, h, s.z + Math.cos(az) * flat);
    return { pos, look };
  }

  update(t, rows, dt, snap = false) {
    if (!this.enabled || !this.script) return;
    const shot = this.shotAt(t);
    if (!shot) return;
    const cut = shot !== this.shot;
    this.shot = shot;
    const s = this.subjectAt(shot, t, rows);
    const goal = new THREE.Vector3(s.x, 0, s.z);
    const kf = snap || cut ? 1 : 1 - Math.exp(-dt * 3);
    this.target.x += (goal.x - this.target.x) * kf;
    this.target.z += (goal.z - this.target.z) * kf;
    const { pos, look } = this.pose(shot, t, rows, { ...s, x: this.target.x, z: this.target.z });
    this.target.y = look.y;
    const cam = this.stage.camera;
    cam.position.copy(pos);
    cam.lookAt(look);
    // Focus on the subject (the look-at point, so it follows them), and
    // blur by shot size: none in wide shots, most in close-ups.
    const T = TYPES[shot.type] ?? TYPES[LEGACY[shot.framing]] ?? TYPES.medium;
    this.focusPoint ??= new THREE.Vector3();
    this.focusPoint.copy(look);
    this.look.setFocus({ point: this.focusPoint, blur: T.blur });
  }

  // ---- planning --------------------------------------------------------------
  // Cut the film into shots. `set` holds the placed props (by script key).
  planShots(rows, duration, set) {
    const script = this.script;
    const castIds = Object.keys(rows);
    const visible = (id, t) => rows[id] && t >= rows[id].offset - 1e-3;
    const placed = Object.values(rows).flatMap((r) => r.beats.map((b) => ({ ...b, cast: r.castId, kind: kind(b.beat) })));
    const beatAt = (id, t) => placed.find((b) => b.cast === id && t >= b.start - 1e-3 && t < b.end);

    // Props that could block a shot, as boxes.
    const keys = new Set(script.props.map((p) => p.key));
    const boxes = [];
    set?.children.forEach((o) => {
      if (!keys.has(o.name)) return;
      const b = new THREE.Box3().setFromObject(o);
      if (b.max.y > 0.7) boxes.push(b.expandByScalar(0.15));
    });
    // The world fill's bushes and boulders are tall enough to block a low
    // camera too (its trees hide themselves near the camera).
    const m4 = new THREE.Matrix4();
    set?.traverse((o) => {
      if (!o.isInstancedMesh || !/^fill-(bushes|boulders)$/.test(o.name)) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4);
        const b = o.geometry.boundingBox.clone().applyMatrix4(m4);
        if (b.max.y > 0.6 && Math.hypot(b.min.x, b.min.z) < 40) boxes.push(b);
      }
    });

    // Cut points: where a non-idle action starts, plus the film's start.
    const starts = [...new Set(placed.filter((b) => b.kind !== 'idle').map((b) => +b.start.toFixed(2)))].sort((a, b) => a - b);
    const cuts = [0];
    for (const c of starts) if (c - cuts.at(-1) >= MIN_SHOT && duration - c >= MIN_SHOT) cuts.push(c);
    // The establishing shot stays short when the first action starts at 0.
    const est = Math.min(3, duration / 4);
    if (cuts.length < 2 || cuts[1] - est >= MIN_SHOT) cuts.splice(1, 0, est);
    cuts.push(duration);
    // Long stretches get a second angle.
    const segs = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      const n = Math.max(1, Math.round((b - a) / MAX_SHOT));
      for (let j = 0; j < n; j++) segs.push([a + (b - a) * j / n, a + (b - a) * (j + 1) / n, j > 0]);
    }
    // Reactions: another character's action that starts inside a shot (too
    // soon after its cut to get its own) gets a short cut to them.
    const REACT = 1.4;
    for (let i = 0; i < segs.length; i++) {
      const [a, b, split] = segs[i];
      const lead = placed.find((x) => x.kind !== 'idle' && Math.abs(x.start - a) < 0.6);
      const other = placed.find((x) => /gesture|dance|sit|act/.test(x.kind) && lead && x.cast !== lead.cast
        && x.beat.action !== lead.beat.action && x.start > a + 0.2 && x.start < b - REACT && b - a >= 2 * REACT
        && (() => { // not when they share the frame anyway
          const p = this.pointAt(x.cast, x.start, rows), q = this.pointAt(lead.cast, x.start, rows);
          return Math.hypot(p[0] - q[0], p[1] - q[1]) > 2.2;
        })());
      if (!other) continue;
      const m = Math.min(Math.max(other.start, a + REACT), b - REACT);
      segs.splice(i, 1, [a, m, split], [m, b, false, other.cast]);
      i++;
    }
    // A short closing wide shot, if there's room.
    const last = segs.at(-1);
    if (last && last[1] - last[0] >= 2 * MIN_SHOT && segs.length > 1) {
      const m = last[1] - Math.min(3.5, (last[1] - last[0]) / 2);
      segs.splice(-1, 1, [last[0], m, last[2]], [m, last[1], true]);
    }

    // The 180° line: between the first two characters.
    const pair = castIds.length >= 2 ? castIds.slice(0, 2) : null;
    let lineSide = 0;
    const sideOf = (pos, t) => {
      if (!pair || !pair.every((id) => visible(id, t))) return 0;
      const a = this.pointAt(pair[0], t, rows), b = this.pointAt(pair[1], t, rows);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 14) return 0; // too far apart to relate
      return Math.sign((b[0] - a[0]) * (pos.z - a[1]) - (b[1] - a[1]) * (pos.x - a[0]));
    };

    // Blocked: a prop box between the camera and any subject's chest (or the
    // camera inside a prop), at the start, middle and end of the shot.
    const hit = new THREE.Vector3();
    const blocked = (shot) => {
      const subs = [].concat(shot.subject);
      for (const f of [0.1, 0.5, 0.9]) {
        const t = shot.start + shot.duration * f;
        const s = this.subjectAt(shot, t, rows);
        const { pos } = this.pose(shot, t, rows, s);
        if (pos.y < 0.2) return true;
        for (const id of subs) {
          const p = this.pointAt(id, t, rows);
          const k = typeof id === 'string' && rows[id] ? this.castScale(id) : 1;
          const feet = new THREE.Vector3(p[0], 0.3, p[1]);
          for (const y of [1.1 * k, 0.5 * k]) {
            const subj = new THREE.Vector3(p[0], y, p[1]);
            const dir = subj.clone().sub(pos);
            const L = dir.length();
            const ray = new THREE.Ray(pos, dir.normalize());
            for (const b of boxes) {
              if (b.containsPoint(pos)) return true;
              // A prop the subject stands on, sits on or in (a dock, a bench,
              // a boat) doesn't block.
              if (b.distanceToPoint(feet) < 0.7) continue;
              if (ray.intersectBox(b, hit) && hit.distanceTo(pos) < L - 0.4) return true;
            }
          }
        }
      }
      return false;
    };

    const shots = [];
    let prev = null;
    segs.forEach(([start, end, split, react], i) => {
      const mid = (start + end) / 2;
      const vis = castIds.filter((id) => visible(id, start + 0.05));
      const all = vis.length ? vis : castIds;
      // Who acts here: the non-idle beats running at the segment's start.
      const acting = all.map((id) => beatAt(id, start + 0.05)).filter((b) => b && b.kind !== 'idle');
      const fresh = acting.filter((b) => Math.abs(b.start - start) < 0.6);
      let main = react ? beatAt(react, start + 0.05) : (fresh[0] ?? acting[0] ?? null);
      let subject = main ? [main.cast] : all;
      // Two characters starting together, close by: a two-shot.
      if (fresh.length >= 2) {
        const [a, b] = fresh.map((x) => this.pointAt(x.cast, mid, rows));
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 6) subject = fresh.map((x) => x.cast);
      }
      const k = main?.kind ?? 'act';
      // Someone right next to a sitting or gesturing subject: frame both.
      if (subject.length === 1 && (k === 'sit' || k === 'gesture')) {
        const p0 = this.pointAt(subject[0], mid, rows);
        const near = all.filter((id) => id !== subject[0] && (() => {
          const q = this.pointAt(id, mid, rows);
          return Math.hypot(q[0] - p0[0], q[1] - p0[1]) < 2.2;
        })());
        if (near.length) subject = [subject[0], ...near];
      }
      const first = i === 0, closing = i === segs.length - 1 && segs.length > 2 && split;
      if (first || closing) subject = all;
      // Partner for an over-the-shoulder: another visible character nearby.
      let partner = null;
      if (subject.length === 1) {
        const p0 = this.pointAt(subject[0], mid, rows);
        partner = all.find((id) => id !== subject[0] && (() => {
          const q = this.pointAt(id, mid, rows);
          const d = Math.hypot(q[0] - p0[0], q[1] - p0[1]);
          // Only if the subject faces the partner (side by side doesn't work).
          const toward = Math.atan2(q[0] - p0[0], q[1] - p0[1]);
          return d > 1.5 && d < 9 && Math.abs(wrap(toward - this.facingAt(subject[0], mid, rows))) < 65 * RAD;
        })()) ?? null;
      }

      // The type and move, by what's happening.
      let prefs;
      if (first) prefs = [['wide', 'crane']];
      else if (closing) prefs = [['wide', 'rise']];
      else if (k === 'run') prefs = [['low', 'static'], ['side', 'static'], ['medium', 'pull']];
      else if (k === 'walk') prefs = [['side', 'static'], ['medium', 'pull'], ['low', 'static']];
      else if (k === 'dance') prefs = [['low', 'orbit'], ['medium', 'orbit'], ['close', 'static']];
      else if (k === 'gesture') prefs = partner ? [['ots', 'dolly'], ['close', 'dolly'], ['medium', 'static']] : [['close', 'dolly'], ['medium', 'static'], ['low', 'static']];
      else if (k === 'sit') prefs = [['medium', 'orbit'], ['close', 'static'], ['side', 'static']];
      else prefs = [['medium', 'dolly'], ['close', 'static'], ['side', 'static']];
      if (split && !closing) prefs = [...prefs.slice(1), prefs[0]];
      if (subject.length > 1) prefs = prefs.filter(([t]) => t !== 'ots').map(([t, m]) => [t === 'close' ? 'medium' : t, m]).concat([['medium', 'orbit'], ['wide', 'static']]);
      prefs.push(['medium', 'static'], ['wide', 'static']);

      // The subject's facing (or travel direction while it moves).
      const lead = subject[0];
      let face = this.facingAt(lead, mid, rows);
      if (main && (k === 'walk' || k === 'run')) {
        const a = this.pointAt(lead, Math.max(start, main.start), rows), b = this.pointAt(lead, Math.min(end, main.end), rows);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1) face = Math.atan2(b[0] - a[0], b[1] - a[1]);
      }

      let chosen = null;
      for (const [type, move] of prefs) {
        if (type === 'ots' && !partner) continue;
        const T = TYPES[type];
        // No jump cut: same subject, same size, close angle.
        const sameSubj = prev && [].concat(prev.subject).sort().join() === [...subject].sort().join();
        if (prev && sameSubj && prev.type === type && !first) continue;
        // Faces, not backs: only wide and side shots may swing far around.
        const offs = [0, 20, -20, 40, -40, 60, -60, ...(type === 'wide' || type === 'side' ? [90, -90, 130, -130, 180] : [])];
        for (const off of offs) {
          for (const sgn of [1, -1]) {
            const shot = {
              id: `s${shots.length + 1}`, start: +start.toFixed(2), duration: +(end - start).toFixed(2),
              type, move, framing: type, subject: subject.length > 1 ? subject : subject[0],
              angle: Math.round(wrap(face + sgn * (T.off + off) * RAD) / RAD), side: sgn,
              ...(type === 'ots' ? { partner } : {}),
              action: main ? `${main.cast} ${main.beat.action ?? main.kind}` : 'the scene',
            };
            if (prev && sameSubj && TYPES[prev.type].size === T.size && Math.abs(wrap((shot.angle - prev.angle) * RAD)) < 35 * RAD) continue;
            const m = this.pose(shot, mid, rows, this.subjectAt(shot, mid, rows)).pos;
            const side = sideOf(m, mid);
            if (lineSide && side && side !== lineSide && type !== 'wide') continue;
            if (blocked(shot)) continue;
            if (!lineSide && side) lineSide = side;
            chosen = shot;
            break;
          }
          if (chosen) break;
        }
        if (chosen) break;
      }
      if (!chosen) {
        chosen = { id: `s${shots.length + 1}`, start: +start.toFixed(2), duration: +(end - start).toFixed(2), type: 'wide', move: 'static',
          framing: 'wide', subject: all.length > 1 ? all : all[0], angle: Math.round(face / RAD + 35), side: 1, action: 'the scene' };
      }
      shots.push(chosen);
      prev = chosen;
    });
    this.shots = shots;
    this.shot = null;
    return shots;
  }
}

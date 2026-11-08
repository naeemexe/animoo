// The director camera: plays the script's shots. Each shot frames its
// subject(s) from `angle` at a distance set by `framing`, follows them gently,
// and cuts hard at shot boundaries.
import * as THREE from 'three';
import { LOOK } from '../look.js';

const RAD = Math.PI / 180;
// distance (m), height ratio, look-at height, tilt-shift band half-height
const FRAMING = {
  wide: { dist: 26, up: 0.72, look: 0.6, band: 0.16 },
  medium: { dist: 11, up: 0.5, look: 0.9, band: 0.24 },
  close: { dist: 5.5, up: 0.32, look: 1.2, band: 0.32 },
};

export class DirectorCamera {
  constructor(stage, look) {
    this.stage = stage;
    this.look = look;
    this.enabled = false;
    this.script = null;
    this.target = new THREE.Vector3();
    this.shot = null;
  }

  setScript(script, resolve) {
    this.script = script;
    this.resolve = resolve;
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
      this.setBand(LOOK.tiltBand);
    }
  }

  setBand(b) {
    this.look.uniforms.tiltH.band.value = this.look.uniforms.tiltV.band.value = b;
  }

  shotAt(t) {
    const shots = this.script?.shots ?? [];
    return shots.find((s) => t >= s.start && t < s.start + s.duration) ?? shots.at(-1);
  }

  // Where the subject(s) are at film time t: the mean of their positions,
  // using the characters' merged clips (rows) when they're on screen.
  subjectAt(shot, t, rows) {
    const list = Array.isArray(shot.subject) && typeof shot.subject[0] !== 'number' ? shot.subject : [shot.subject];
    let x = 0, z = 0, spread = 0;
    const pts = list.map((s) => {
      if (rows[s] && t >= rows[s].offset) return rows[s].positionAt(t);
      return this.resolve(s, t);
    });
    for (const p of pts) { x += p[0]; z += p[1]; }
    x /= pts.length; z /= pts.length;
    for (const p of pts) spread = Math.max(spread, Math.hypot(p[0] - x, p[1] - z));
    return { x, z, spread };
  }

  update(t, rows, dt, snap = false) {
    if (!this.enabled || !this.script) return;
    const shot = this.shotAt(t);
    if (!shot) return;
    const cut = shot !== this.shot;
    this.shot = shot;
    const F = FRAMING[shot.framing] ?? FRAMING.medium;
    const s = this.subjectAt(shot, t, rows);
    // Pull back so a spread-out group stays in frame.
    const dist = F.dist + s.spread * 1.6;
    const goal = new THREE.Vector3(s.x, F.look, s.z);
    const k = snap || cut ? 1 : 1 - Math.exp(-dt * 2.5);
    this.target.lerp(goal, k);
    const a = (shot.angle ?? 35) * RAD;
    const flat = dist * Math.sqrt(1 - F.up * F.up);
    const cam = this.stage.camera;
    cam.position.set(this.target.x + Math.sin(a) * flat, this.target.y + dist * F.up, this.target.z + Math.cos(a) * flat);
    cam.lookAt(this.target);
    this.setBand(F.band);
  }
}

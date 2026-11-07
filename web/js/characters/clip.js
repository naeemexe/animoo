// A retargeted clip: per frame, each VRM bone's rotation away from rest (D, in
// character space), the hips position, and the two ankle targets with
// contact flags. Plain typed arrays, so clips are cheap to slice, turn and merge.
import * as THREE from 'three';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const FWD = new THREE.Vector3(0, 0, 1);

export class Clip {
  constructor({ name = '', fps = 30, frames, bones, parents }) {
    this.name = name;
    this.fps = fps;
    this.frames = frames;
    this.bones = bones;
    this.parents = parents;
    this.rot = new Float32Array(frames * bones.length * 4);
    this.hips = new Float32Array(frames * 3);
    this.feet = { left: new Float32Array(frames * 3), right: new Float32Array(frames * 3) };
    this.contact = { left: new Uint8Array(frames), right: new Uint8Array(frames) };
    this.segments = [{ name, start: 0, end: frames }]; // which source clip each frame range came from
  }

  get duration() { return (this.frames - 1) / this.fps; }

  static like(src, frames, name = src.name) {
    return new Clip({ name, fps: src.fps, frames, bones: src.bones, parents: src.parents });
  }

  hipsQuat(f, out = new THREE.Quaternion()) {
    return out.fromArray(this.rot, f * this.bones.length * 4); // bone 0 is the hips
  }

  // Facing angle about Y (0 = +Z), read from the hips.
  heading(f) {
    _v.copy(FWD).applyQuaternion(this.hipsQuat(f, _q));
    return Math.atan2(_v.x, _v.z);
  }

  // Turn the whole clip by `yaw` about the vertical axis through `pivot`
  // (x, z), then move it by `offset` (x, z). In place.
  transform(yaw, pivot = [0, 0], offset = [0, 0]) {
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const move = (arr) => {
      for (let f = 0; f < this.frames; f++) {
        const x = arr[f * 3] - pivot[0], z = arr[f * 3 + 2] - pivot[1];
        arr[f * 3] = c * x + s * z + pivot[0] + offset[0];
        arr[f * 3 + 2] = -s * x + c * z + pivot[1] + offset[1];
      }
    };
    move(this.hips);
    move(this.feet.left);
    move(this.feet.right);
    for (let i = 0; i < this.rot.length; i += 4) {
      _q.fromArray(this.rot, i).premultiply(turn).toArray(this.rot, i);
    }
    return this;
  }

  // Start at the origin facing +Z.
  normalizeStart() {
    const h = this.heading(0);
    return this.transform(-h, [this.hips[0], this.hips[2]], [-this.hips[0], -this.hips[2]]);
  }

  // A foot is planted when its ankle is near standing height and nearly still.
  detectContacts(ankleRest, { height = 0.035, speed = 0.2 } = {}) {
    for (const side of ['left', 'right']) {
      const p = this.feet[side], c = this.contact[side];
      for (let f = 0; f < this.frames; f++) {
        const a = Math.max(f - 1, 0), b = Math.min(f + 1, this.frames - 1);
        const v = Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 2] - p[a * 3 + 2]) * this.fps / Math.max(b - a, 1);
        c[f] = p[f * 3 + 1] - ankleRest < height && v < speed ? 1 : 0;
      }
    }
    return this;
  }

  // Copy frame `f` of `src` into frame `g` of this clip.
  copyFrame(g, src, f) {
    const B = this.bones.length * 4;
    this.rot.set(src.rot.subarray(f * B, f * B + B), g * B);
    this.hips.set(src.hips.subarray(f * 3, f * 3 + 3), g * 3);
    for (const s of ['left', 'right']) {
      this.feet[s].set(src.feet[s].subarray(f * 3, f * 3 + 3), g * 3);
      this.contact[s][g] = src.contact[s][f];
    }
  }

  clone() {
    const c = Clip.like(this, this.frames);
    for (let f = 0; f < this.frames; f++) c.copyFrame(f, this, f);
    c.segments = this.segments.map((s) => ({ ...s }));
    return c;
  }

  // Kimodo pads a clip that's shorter than asked with near-still frames.
  // Drop a still tail, keeping `keep` seconds of it so the pose settles.
  trimStill({ eps = 0.0015, keep = 0.2 } = {}) {
    const B = this.bones.length * 4;
    let last = this.frames - 1;
    const moved = (f) => {
      let d = Math.hypot(this.hips[f * 3] - this.hips[f * 3 - 3], this.hips[f * 3 + 1] - this.hips[f * 3 - 2], this.hips[f * 3 + 2] - this.hips[f * 3 - 1]);
      for (let i = 0; i < B; i++) d = Math.max(d, Math.abs(this.rot[f * B + i] - this.rot[(f - 1) * B + i]));
      return d > eps;
    };
    while (last > 1 && !moved(last)) last--;
    const end = Math.min(this.frames, last + 1 + Math.round(keep * this.fps));
    if (end >= this.frames) return this;
    const c = Clip.like(this, end);
    for (let f = 0; f < end; f++) c.copyFrame(f, this, f);
    c.segments = [{ name: this.name, start: 0, end }];
    return c;
  }
}

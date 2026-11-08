// A character on stage: one VRM, its list of clips, and playback.
//
// The clip list is merged into one continuous clip (merge.js), which plays
// once and then holds its last pose (never looping padded frames). Every frame
// the pose is written onto the VRM's normalized bones, the legs are solved
// with two-bone IK onto the clip's foot targets, and vrm.update() copies the
// pose to the mesh and runs the spring bones (hair, clothes).
import * as THREE from 'three';
import { mergeAll } from './merge.js';

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _w = [];

function sampleQuat(clip, i, f0, f1, t, out) {
  const B4 = clip.bones.length * 4;
  out.fromArray(clip.rot, f0 * B4 + i * 4);
  if (t > 0) out.slerp(_q2.fromArray(clip.rot, f1 * B4 + i * 4), t);
  return out;
}
function sampleVec(arr, f0, f1, t, out) {
  return out.set(
    arr[f0 * 3] + (arr[f1 * 3] - arr[f0 * 3]) * t,
    arr[f0 * 3 + 1] + (arr[f1 * 3 + 1] - arr[f0 * 3 + 1]) * t,
    arr[f0 * 3 + 2] + (arr[f1 * 3 + 2] - arr[f0 * 3 + 2]) * t,
  );
}

// Set a node's world rotation (given in the character group's space).
function setGroupRotation(node, groupQ, group) {
  node.parent.updateWorldMatrix(true, false);
  const parentQ = node.parent.getWorldQuaternion(_q);
  const gq = group.getWorldQuaternion(new THREE.Quaternion());
  // local = parent⁻¹ · group · groupQ
  node.quaternion.copy(parentQ.invert().multiply(gq).multiply(groupQ));
}

export class Character {
  constructor(vrm, retargeter, { name = 'character' } = {}) {
    this.vrm = vrm;
    this.retargeter = retargeter;
    this.rig = retargeter.rig;
    this.group = new THREE.Group();
    this.group.name = name;
    this.group.add(vrm.scene);
    this.nodes = this.rig.bones.map((b) => vrm.humanoid.getNormalizedBoneNode(b));
    this.clips = [];
    this.clip = null;
    this.time = 0;
    this.playing = true;
    this.ik = true;
    this.D = this.rig.bones.map(() => new THREE.Quaternion());
    this.legs = ['left', 'right'].map((s) => ({
      side: s,
      upper: vrm.humanoid.getNormalizedBoneNode(`${s}UpperLeg`),
      lower: vrm.humanoid.getNormalizedBoneNode(`${s}LowerLeg`),
      foot: vrm.humanoid.getNormalizedBoneNode(`${s}Foot`),
      footIdx: this.rig.bones.indexOf(`${s}Foot`),
    }));
  }

  get duration() { return this.clip ? this.clip.duration : 0; }

  // Retarget a BVH (text or parsed) into a clip without adding it.
  makeClip(bvh, name) {
    return this.retargeter.retarget(bvh, name).trimStill();
  }

  setClips(clips, opts) {
    this.clips = clips;
    this.clip = clips.length ? mergeAll(clips, opts) : null;
    this.seek(0);
    return this.clip;
  }

  addClip(clip, opts) { return this.setClips([...this.clips, clip], opts); }

  seek(t) {
    this.time = THREE.MathUtils.clamp(t, 0, this.duration);
    this.apply();
  }

  update(dt) {
    if (this.clip && this.playing) {
      this.time = Math.min(this.time + dt, this.duration);
      this.apply();
    }
    this.vrm.update(dt);
  }

  // Write the pose at this.time onto the VRM.
  apply() {
    const clip = this.clip;
    if (!clip) return;
    const x = this.time * clip.fps;
    const f0 = Math.min(Math.floor(x), clip.frames - 1);
    const f1 = Math.min(f0 + 1, clip.frames - 1);
    const t = x - f0;
    const { sceneQ } = this.rig;
    const vrmScene = this.vrm.scene;

    // World (group-space) rotation W = D · sceneQ; local = W_parent⁻¹ · W_self.
    for (let i = 0; i < this.nodes.length; i++) sampleQuat(clip, i, f0, f1, t, this.D[i]);
    for (let i = 0; i < this.nodes.length; i++) {
      const p = clip.parents[i];
      _w[i] ??= new THREE.Quaternion();
      _w[i].copy(this.D[i]).multiply(sceneQ);
      const local = this.nodes[i].quaternion;
      if (p < 0) {
        // Parent chain up to the group: the VRM scene and the normalized root.
        this.nodes[i].parent.updateWorldMatrix(true, false);
        const toGroup = this.group.matrixWorld.clone().invert().multiply(this.nodes[i].parent.matrixWorld);
        local.copy(new THREE.Quaternion().setFromRotationMatrix(toGroup).invert().multiply(_w[i]));
      } else {
        local.copy(_q.copy(_w[p]).invert().multiply(_w[i]));
      }
    }

    // Hips position, given in group space.
    const hips = this.nodes[0];
    const hp = sampleVec(clip.hips, f0, f1, t, new THREE.Vector3());
    hips.parent.updateWorldMatrix(true, false);
    hips.position.copy(this.group.localToWorld(hp)).applyMatrix4(hips.parent.matrixWorld.clone().invert());

    if (this.ik) {
      vrmScene.updateMatrixWorld(true);
      // A planted foot goes exactly onto its target; a swinging foot follows
      // the animation (blended in over a few frames around each plant), so a
      // swing never snaps the leg toward a target it can't reach in time.
      const W = ikWeights(clip);
      const targets = this.legs.map((leg) => {
        const T = this.group.localToWorld(sampleVec(clip.feet[leg.side], f0, f1, t, new THREE.Vector3()));
        const w = W[leg.side][f0] + (W[leg.side][f1] - W[leg.side][f0]) * t;
        return w >= 1 ? T : leg.foot.getWorldPosition(new THREE.Vector3()).lerp(T, w);
      });
      // Kimodo plants its feet with the leg almost straight, and its ankles
      // land at 100–103 % of the VRM leg's reach. Lower the hips just enough
      // that both targets sit inside REACH of the leg, so the IK never has to
      // snap a leg straight (where the knee can flip backward).
      let drop = 0;
      for (let k = 0; k < 2; k++) {
        const { upper, lower, foot } = this.legs[k];
        upper.getWorldPosition(_A); lower.getWorldPosition(_B); foot.getWorldPosition(_C);
        const R = REACH * (_A.distanceTo(_B) + _B.distanceTo(_C));
        const T = targets[k], h2 = (T.x - _A.x) ** 2 + (T.z - _A.z) ** 2, v = _A.y - T.y;
        if (h2 < R * R) drop = Math.max(drop, v - Math.sqrt(R * R - h2));
      }
      drop = Math.min(drop, MAX_DROP);
      if (drop > 0) {
        hips.position.y -= drop / hips.parent.getWorldScale(_C).y;
        vrmScene.updateMatrixWorld(true);
      }
      this.hipDrop = drop;
      for (let k = 0; k < 2; k++) {
        const leg = this.legs[k], target = targets[k];
        const footW = this.D[leg.footIdx].clone().multiply(sceneQ); // desired foot rotation, group space
        leg.forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.D[0]).transformDirection(this.group.matrixWorld);
        solveLeg(leg, target);
        setGroupRotation(leg.foot, footW, this.group);
        leg.foot.updateMatrixWorld(true);
      }
    }
  }
}

// Per frame and foot, how much the IK target counts: 1 while planted, eased
// to 0 over IK_EASE frames before and after. Cached per clip.
const IK_EASE = 6;
const _weights = new WeakMap();
function ikWeights(clip) {
  let W = _weights.get(clip);
  if (W) return W;
  W = {};
  for (const s of ['left', 'right']) {
    const c = clip.contact[s], w = W[s] = new Float32Array(clip.frames);
    let last = -Infinity;
    for (let f = 0; f < clip.frames; f++) { if (c[f]) last = f; w[f] = f - last; }
    last = Infinity;
    for (let f = clip.frames - 1; f >= 0; f--) {
      if (c[f]) last = f;
      const d = Math.min(w[f], last - f);
      const x = Math.max(0, 1 - d / (IK_EASE + 1));
      w[f] = x * x * (3 - 2 * x);
    }
  }
  _weights.set(clip, W);
  return W;
}

// Two-bone IK in world space. The knee stays in the plane the animation put it
// in, nudged toward the body's front so a nearly straight leg can't flip its
// knee backward, and the bone lengths never change. Reach is soft: past
// SOFT of the leg length the knee straightens asymptotically, never snapping.
const REACH = 0.998, SOFT = 0.995, MAX_DROP = 0.05, POLE_BIAS = 0.12;
const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C = new THREE.Vector3();
function softReach(d, L) {
  const s = SOFT * L, m = 0.9995 * L - s;
  return d <= s ? d : s + m * (1 - Math.exp(-(d - s) / m));
}
function solveLeg(leg, T) {
  const { upper, lower, foot } = leg;
  upper.getWorldPosition(_A);
  lower.getWorldPosition(_B);
  foot.getWorldPosition(_C);
  const a = _A.distanceTo(_B), b = _B.distanceTo(_C);
  const AT = T.clone().sub(_A);
  const d = Math.max(softReach(AT.length(), a + b), Math.abs(a - b) + 1e-4);
  const dir = AT.normalize();
  // Pole: which way the animation bends the knee (its offset from the
  // animation's own hip→ankle line; measured against the hip→target line it
  // can point sideways or back when the target is far from the animated foot),
  // plus a small pull toward the body's front (it decides when the leg is straight).
  const fk = _C.clone().sub(_A).normalize();
  const pole = _B.clone().sub(_A);
  pole.addScaledVector(fk, -pole.dot(fk)).addScaledVector(leg.forward, POLE_BIAS * a);
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-10) pole.copy(leg.forward).addScaledVector(dir, -leg.forward.dot(dir));
  pole.normalize();
  const along = (a * a - b * b + d * d) / (2 * d);
  const knee = _A.clone().addScaledVector(dir, along).addScaledVector(pole, Math.sqrt(Math.max(a * a - along * along, 0)));

  rotateToward(upper, _B.clone().sub(_A), knee.clone().sub(_A));
  upper.updateMatrixWorld(true);
  lower.getWorldPosition(_B);
  foot.getWorldPosition(_C);
  const footTarget = _A.clone().addScaledVector(dir, d);
  rotateToward(lower, _C.clone().sub(_B), footTarget.sub(_B));
  lower.updateMatrixWorld(true);
}

// Rotate `node` (in world space) so world vector `from` turns onto `to`.
function rotateToward(node, from, to) {
  const r = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
  const world = node.getWorldQuaternion(new THREE.Quaternion()).premultiply(r);
  const parentQ = node.parent.getWorldQuaternion(new THREE.Quaternion());
  node.quaternion.copy(parentQ.invert().multiply(world));
}

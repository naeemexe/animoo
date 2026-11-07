// BVH parsing and forward kinematics. Kimodo writes centimeters, Y up, the
// character facing +Z, and a degenerate rest pose (every offset along local +X),
// so the rest pose itself means nothing; only posed frames do.
import * as THREE from 'three';

const AXES = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };

// → { joints: [{ name, parent, offset: Vector3, channels: [] }], frameTime, fps, frames: Float32Array[] }
export function parseBVH(text) {
  const lines = text.split(/\r?\n/);
  const joints = [];
  const stack = [];
  let cur = -1;
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'MOTION') break;
    if (t[0] === 'ROOT' || t[0] === 'JOINT') {
      joints.push({ name: t[1], parent: stack.length ? stack.at(-1) : -1, offset: new THREE.Vector3(), channels: [] });
      cur = joints.length - 1;
    } else if (t[0] === 'End') {
      const parent = stack.at(-1);
      joints.push({ name: `${joints[parent].name}End`, parent, offset: new THREE.Vector3(), channels: [], end: true });
      cur = joints.length - 1;
    } else if (t[0] === '{') stack.push(cur);
    else if (t[0] === '}') stack.pop();
    else if (t[0] === 'OFFSET') joints[cur].offset.set(+t[1], +t[2], +t[3]);
    else if (t[0] === 'CHANNELS') joints[cur].channels = t.slice(2);
  }
  // Kimodo already names its toe end "LeftToeEnd"; keep the first of any duplicate.
  const seen = new Set();
  for (const j of joints) { if (seen.has(j.name)) j.name += '_'; seen.add(j.name); }

  const frameCount = parseInt(lines[i + 1].split(':')[1], 10);
  const frameTime = parseFloat(lines[i + 2].split(':')[1]);
  const frames = [];
  for (let k = i + 3; k < lines.length && frames.length < frameCount; k++) {
    const s = lines[k].trim();
    if (s) frames.push(Float32Array.from(s.split(/\s+/), Number));
  }
  return { joints, frameTime, fps: 1 / frameTime, frames };
}

// World position (cm) and rotation of every joint for one frame.
// Returns { pos: Vector3[], rot: Quaternion[] }, reusing `out` when given.
export function poseBVH(bvh, frame, out) {
  const n = bvh.joints.length;
  out ??= { pos: Array.from({ length: n }, () => new THREE.Vector3()), rot: Array.from({ length: n }, () => new THREE.Quaternion()) };
  const q = new THREE.Quaternion();
  const t = new THREE.Vector3();
  let k = 0;
  for (let j = 0; j < n; j++) {
    const J = bvh.joints[j];
    t.copy(J.offset);
    const r = out.rot[j].identity();
    for (const c of J.channels) {
      const v = frame[k++];
      if (c.endsWith('position')) t.setComponent('XYZ'.indexOf(c[0]), v);
      else r.multiply(q.setFromAxisAngle(AXES[c[0]], THREE.MathUtils.degToRad(v)));
    }
    if (J.parent < 0) out.pos[j].copy(t);
    else {
      out.pos[j].copy(t).applyQuaternion(out.rot[J.parent]).add(out.pos[J.parent]);
      r.premultiply(out.rot[J.parent]);
    }
  }
  return out;
}

export function jointIndex(bvh) {
  return Object.fromEntries(bvh.joints.map((j, i) => [j.name, i]));
}

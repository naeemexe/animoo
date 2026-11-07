// Kimodo BVH → VRM retargeting.
//
// The rigs' local bone axes differ, and Kimodo's rest pose is degenerate, so
// rotations can't be copied. Instead each bone gets an anatomical frame (aim
// along the bone, roll pinned to something both rigs have: the facing, world
// up, or the thumb). Measured once on a standing Kimodo frame and on the VRM's
// T-pose, the two frames give one constant rotation per bone:
//
//   VRM world rotation(t) = BVH world rotation(t) · C · VRM rest rotation
//   C = BVH ref rotation⁻¹ · F_bvh · F_vrm⁻¹
//
// so the VRM bone's anatomical frame follows the BVH bone's exactly. The clip
// stores D = world · rest⁻¹ per bone ("rotation away from the VRM's rest pose,
// in character space"), which makes turning a clip a single premultiply.
//
// The root path is scaled by the leg-length ratio, and the BVH ankle positions
// become foot targets for leg IK (player.js), so the VRM's feet land where
// Kimodo's did even though its legs are shaped differently.
import * as THREE from 'three';
import { parseBVH, poseBVH, jointIndex } from './bvh.js';
import { RIG, REF_JOINTS } from './rig.js';
import { Clip } from './clip.js';

const UP = new THREE.Vector3(0, 1, 0);

function basis(aim, ref) {
  const x = aim.clone().normalize();
  const y = ref.clone().addScaledVector(x, -ref.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

// Direction of each bone and the roll reference vectors, on one rig.
function frames(rows, P, refNames, isBvh) {
  const fwd = P(refNames.leftHip).clone().sub(P(refNames.rightHip)).cross(UP).setY(0).normalize();
  const out = new Map();
  for (const row of rows) {
    const [bName, vName, bAim, vAim, roll] = row;
    const name = isBvh ? bName : vName;
    let aim;
    const aimName = isBvh ? bAim : vAim;
    if (aimName === '@up') aim = UP.clone();
    else if (bAim && vAim) aim = P(aimName).clone().sub(P(name));
    else {
      const parentRow = rows.find((r) => r[2] === bName); // the row that aims at this joint
      const pn = isBvh ? parentRow[0] : parentRow[1];
      aim = P(name).clone().sub(P(pn));
    }
    const side = bName.startsWith('Left') ? 'Left' : 'Right';
    let ref;
    if (roll === 'fwd') ref = fwd;
    else if (roll === 'up') ref = UP;
    else if (roll === 'thumb') ref = P(refNames[`${side}Thumb`]).clone().sub(P(isBvh ? `${side}Hand` : `${side.toLowerCase()}Hand`));
    else ref = P(refNames[`${side}Knuckle`]).clone().sub(P(isBvh ? `${side}Hand` : `${side.toLowerCase()}Hand`));
    out.set(bName, basis(aim, ref));
  }
  return out;
}

// One per VRM. `refBvh` is a parsed Kimodo clip whose first frame stands upright.
// The VRM must not be parented yet, so its world space is character space.
export function createRetargeter(vrm, refBvh) {
  vrm.scene.updateMatrixWorld(true);
  const node = (n) => vrm.humanoid.getNormalizedBoneNode(n);
  const rows = RIG.filter(([b, v]) => node(v) && b in jointIndex(refBvh));
  const vPos = (n) => node(n)?.getWorldPosition(new THREE.Vector3());
  const restQ = (n) => node(n).getWorldQuaternion(new THREE.Quaternion());

  const bi = jointIndex(refBvh);
  const ref = poseBVH(refBvh, refBvh.frames[0]);
  const bPos = (n) => ref.pos[bi[n]];
  const Fb = frames(rows, bPos, REF_JOINTS.bvh, true);
  const Fv = frames(rows, vPos, REF_JOINTS.vrm, false);

  // Per bone: C · rest · sceneQ⁻¹, so that D(t) = BVH world(t) · CR[k].
  // (The normalized rig's rest rotations are all the scene's rotation, but
  // multiplying them in keeps this right for any rig.)
  const sceneQ = vrm.scene.getWorldQuaternion(new THREE.Quaternion());
  const sceneInv = sceneQ.clone().invert();
  const CR = rows.map(([b, v]) => ref.rot[bi[b]].clone().invert()
    .multiply(Fb.get(b)).multiply(Fv.get(b).clone().invert())
    .multiply(restQ(v)).multiply(sceneInv));

  // Scale: hips-to-ankle height, Kimodo cm → VRM m.
  const vHip = vPos('hips').y, vAnkle = (vPos('leftFoot').y + vPos('rightFoot').y) / 2;
  const bHip = bPos('Hips').y, bAnkle = (bPos('LeftFoot').y + bPos('RightFoot').y) / 2;
  const scale = (vHip - vAnkle) / (bHip - bAnkle);
  const lift = vAnkle - scale * bAnkle;

  // Bone list in hierarchy order with each bone's nearest mapped ancestor.
  const bones = rows.map((r) => r[1]);
  const parents = bones.map((v) => {
    for (let p = node(v).parent; p; p = p.parent) {
      const k = bones.findIndex((b) => node(b) === p);
      if (k >= 0) return k;
    }
    return -1;
  });

  const rig = { bones, parents, sceneQ, scale, lift, ankleRest: vAnkle, legLength: vHip - vAnkle };

  function retarget(bvhOrText, name = '') {
    const bvh = typeof bvhOrText === 'string' ? parseBVH(bvhOrText) : bvhOrText;
    const ji = jointIndex(bvh);
    const n = bvh.frames.length;
    const clip = new Clip({ name, fps: bvh.fps, frames: n, bones, parents });
    const idx = rows.map(([b]) => ji[b]);
    const hipsJ = ji.Hips, lf = ji.LeftFoot, rf = ji.RightFoot;
    const q = new THREE.Quaternion();
    let pose;
    for (let f = 0; f < n; f++) {
      pose = poseBVH(bvh, bvh.frames[f], pose);
      for (let k = 0; k < rows.length; k++) {
        q.copy(pose.rot[idx[k]]).multiply(CR[k]);
        q.toArray(clip.rot, (f * bones.length + k) * 4);
      }
      const put = (arr, p) => {
        arr[f * 3] = p.x * scale; arr[f * 3 + 1] = p.y * scale + lift; arr[f * 3 + 2] = p.z * scale;
      };
      put(clip.hips, pose.pos[hipsJ]);
      put(clip.feet.left, pose.pos[lf]);
      put(clip.feet.right, pose.pos[rf]);
    }
    clip.detectContacts(vAnkle);
    return clip.normalizeStart();
  }

  return { rig, retarget };
}

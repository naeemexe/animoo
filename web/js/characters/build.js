// Body build (task 35): slim → heavy on the same rigged VRM, like a game skin.
//
//   applyBuild(hero.vrm, 'heavy')   // or 'slim', 'sturdy', 'average', or a number -1 … 1
//
// Width only, done like a bone scale that doesn't inherit: each skinned vertex
// moves away from (or toward) the axis of the torso / limb bones it is weighted
// to, in the bind pose. The skeleton itself is untouched (bone lengths,
// positions, the retargeter's frames, the leg IK and foot targets are all
// exactly as before), so animation and foot plants can't change. Scaling the
// bones themselves would shear every child bone as it rotates under them.
import * as THREE from 'three';

// Word → how much wider (0.25 = a quarter wider at the belly, scaled per bone below).
export const BUILDS = { slim: -0.16, average: 0, sturdy: 0.22, stocky: 0.22, heavy: 0.48 };

// Per bone: its axis runs to `to`; how much of the build it takes sideways (x)
// and forward/back (the belly bulges forward more than the back).
const PARTS = [
  { bone: 'hips', to: 'spine', side: 0.85, front: 1.0, back: 0.8 },
  { bone: 'spine', to: 'chest', side: 0.8, front: 1.6, back: 0.6 },
  { bone: 'chest', to: 'upperChest', side: 0.7, front: 1.2, back: 0.55 },
  { bone: 'upperChest', to: 'neck', side: 0.5, front: 0.8, back: 0.4 },
  { bone: 'leftUpperArm', to: 'leftLowerArm', all: 0.75 },
  { bone: 'rightUpperArm', to: 'rightLowerArm', all: 0.75 },
  { bone: 'leftLowerArm', to: 'leftHand', all: 0.35 },
  { bone: 'rightLowerArm', to: 'rightHand', all: 0.35 },
  { bone: 'leftUpperLeg', to: 'leftLowerLeg', all: 0.85 },
  { bone: 'rightUpperLeg', to: 'rightLowerLeg', all: 0.85 },
  { bone: 'leftLowerLeg', to: 'leftFoot', all: 0.35 },
  { bone: 'rightLowerLeg', to: 'rightFoot', all: 0.35 },
];
// Weight on these bones holds a vertex still (the neck seam to the face mesh, hands, feet).
const HOLD = ['neck', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'];

export function buildAmount(build) {
  if (typeof build === 'number' && Number.isFinite(build)) return THREE.MathUtils.clamp(build, -1, 1) * BUILDS.heavy;
  return BUILDS[String(build || '').toLowerCase()] ?? 0;
}

const _m = new THREE.Matrix4();
function bindPos(skel, i) { return new THREE.Vector3().setFromMatrixPosition(_m.copy(skel.boneInverses[i]).invert()); }

export function applyBuild(vrm, build, { bulk = null } = {}) {
  const e = buildAmount(build);
  const done = new Set();
  let moved = 0;
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const geo = o.geometry, pos = geo.attributes.position;
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (!si || !sw) return;
    const skel = o.skeleton;
    const idx = (name) => skel.bones.indexOf(vrm.humanoid.getRawBoneNode(name));
    // Bulk (a winter coat): the coat's own vertices also puff out along their normals.
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const puff = bulk && mats.some((m) => bulk.rx.test(m.name || '')) ? bulk.m : 0;
    if (done.has(pos) && !puff) return;
    const first = !done.has(pos);
    done.add(pos);

    // Front in bind space: from the foot toward the toes.
    const fi = idx('leftFoot'), ti = idx('leftToes');
    const front = fi >= 0 && ti >= 0 && bindPos(skel, ti).z < bindPos(skel, fi).z ? -1 : 1;
    const parts = first && e !== 0 ? PARTS.map((p) => {
      const i = idx(p.bone), j = idx(p.to) >= 0 ? idx(p.to) : idx('neck');
      if (i < 0 || j < 0) return null;
      const o0 = bindPos(skel, i);
      return { ...p, i, o: o0, a: bindPos(skel, j).sub(o0).normalize() };
    }).filter(Boolean) : [];
    const byBone = new Map(parts.map((p) => [p.i, p]));
    const hold = new Set(HOLD.map(idx).filter((i) => i >= 0));
    const v = new THREE.Vector3(), d = new THREE.Vector3(), out = new THREE.Vector3();

    if (parts.length) {
      for (let k = 0; k < pos.count; k++) {
        v.fromBufferAttribute(pos, k);
        out.set(0, 0, 0);
        let held = 0;
        for (let c = 0; c < 4; c++) {
          const b = si.getComponent(k, c), w = sw.getComponent(k, c);
          if (!w) continue;
          if (hold.has(b)) { held += w; continue; }
          const p = byBone.get(b);
          if (!p) continue;
          d.copy(v).sub(p.o);
          d.addScaledVector(p.a, -d.dot(p.a)); // radial part only: width, never length
          if (p.all != null) { out.addScaledVector(d, w * e * p.all); continue; }
          const fz = Math.sign(d.z) === front ? p.front : p.back;
          out.x += w * e * p.side * d.x;
          out.y += w * e * p.side * d.y;
          out.z += w * e * fz * d.z;
        }
        if (out.lengthSq() === 0) continue;
        out.multiplyScalar(Math.max(0, 1 - held));
        pos.setXYZ(k, v.x + out.x, v.y + out.y, v.z + out.z);
        moved++;
      }
    }
    if (puff && geo.index && geo.attributes.normal) {
      const nrm = geo.attributes.normal, seen = new Set();
      for (const g of geo.groups.length ? geo.groups : [{ start: 0, count: geo.index.count }]) {
        for (let n = g.start; n < g.start + g.count; n++) {
          const k = geo.index.getX(n);
          if (seen.has(k)) continue;
          seen.add(k);
          pos.setXYZ(k, pos.getX(k) + nrm.getX(k) * puff, pos.getY(k) + nrm.getY(k) * puff, pos.getZ(k) + nrm.getZ(k) * puff);
        }
      }
      moved += seen.size;
    }
    pos.needsUpdate = true;
  });
  return { amount: e, moved };
}

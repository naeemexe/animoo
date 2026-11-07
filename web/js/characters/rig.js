// Which Kimodo (SOMA) joint drives which VRM humanoid bone, and how to build an
// anatomical frame for each bone on either rig, so the two can be matched no
// matter how each rig orients its local axes.
//
// Each row: [bvh joint, vrm bone, bvh aim joint, vrm aim bone, roll reference].
// The frame's first axis points from the joint to its aim joint (a missing aim
// continues the parent's direction). The roll reference pins the twist about
// that axis ('@up' aims at world up in the rest pose): 'fwd' the body's facing, 'up' world up, 'thumb' the thumb side of
// the hand, 'hand' along the hand toward the fingers.
export const RIG = [
  ['Hips', 'hips', 'Chest', 'upperChest', 'fwd'],
  ['Spine1', 'spine', 'Chest', 'upperChest', 'fwd'],
  ['Spine2', 'chest', 'Neck1', 'neck', 'fwd'],
  ['Chest', 'upperChest', 'Neck1', 'neck', 'fwd'],
  ['Neck1', 'neck', 'Head', 'head', 'fwd'],
  // Kimodo's neck leans 26° forward; aim the head at the top of the skull
  // instead (the VRM's head points straight up in its T-pose).
  ['Head', 'head', 'HeadEnd', '@up', 'fwd'],
  ...side('Left', 'left'),
  ...side('Right', 'right'),
];

function side(B, v) {
  const rows = [
    [`${B}Shoulder`, `${v}Shoulder`, `${B}Arm`, `${v}UpperArm`, 'fwd'],
    [`${B}Arm`, `${v}UpperArm`, `${B}ForeArm`, `${v}LowerArm`, 'fwd'],
    [`${B}ForeArm`, `${v}LowerArm`, `${B}Hand`, `${v}Hand`, 'thumb'],
    [`${B}Hand`, `${v}Hand`, `${B}HandMiddle2`, `${v}MiddleProximal`, 'thumb'],
    [`${B}Leg`, `${v}UpperLeg`, `${B}Shin`, `${v}LowerLeg`, 'fwd'],
    [`${B}Shin`, `${v}LowerLeg`, `${B}Foot`, `${v}Foot`, 'fwd'],
    [`${B}Foot`, `${v}Foot`, `${B}ToeBase`, `${v}Toes`, 'up'],
    [`${B}ToeBase`, `${v}Toes`, null, null, 'up'],
  ];
  // Kimodo fingers have a metacarpal joint (…1) that VRM doesn't, so …2 is the
  // proximal phalanx. three-vrm names thumbs the VRM 1 way (metacarpal,
  // proximal, distal) even for VRM 0 files.
  const fingers = [['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Pinky', 'Little']];
  for (const [bf, vf] of fingers) {
    const vb = ['Proximal', 'Intermediate', 'Distal'];
    for (let k = 0; k < 3; k++) {
      rows.push([`${B}Hand${bf}${k + 2}`, `${v}${vf}${vb[k]}`, k < 2 ? `${B}Hand${bf}${k + 3}` : null, k < 2 ? `${v}${vf}${vb[k + 1]}` : null, 'thumb']);
    }
  }
  const tb = ['Metacarpal', 'Proximal', 'Distal'];
  for (let k = 0; k < 3; k++) {
    rows.push([`${B}HandThumb${k + 1}`, `${v}Thumb${tb[k]}`, k < 2 ? `${B}HandThumb${k + 2}` : null, k < 2 ? `${v}Thumb${tb[k + 1]}` : null, 'hand']);
  }
  return rows;
}

// BVH joints and VRM bones the roll references read.
export const REF_JOINTS = {
  bvh: { leftHip: 'LeftLeg', rightHip: 'RightLeg', LeftThumb: 'LeftHandThumb1', RightThumb: 'RightHandThumb1', LeftKnuckle: 'LeftHandMiddle2', RightKnuckle: 'RightHandMiddle2' },
  vrm: { leftHip: 'leftUpperLeg', rightHip: 'rightUpperLeg', LeftThumb: 'leftThumbMetacarpal', RightThumb: 'rightThumbMetacarpal', LeftKnuckle: 'leftMiddleProximal', RightKnuckle: 'rightMiddleProximal' },
};

// Loading the library's VRM characters (VRoid, VRM 0.x, MToon materials).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

// → a VRM facing +Z, feet at y = 0, in meters, not parented to anything.
export async function loadVRM(url) {
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error(`${url} has no VRM data`);
  // VRM 0 models face -Z; turn them to +Z like everything else here.
  if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
  // The pose is written to the normalized rig, and vrm.update() copies it to
  // the mesh's bones. The normalized root has to be in the scene for that.
  const root = vrm.humanoid.normalizedHumanBonesRoot;
  if (root && !root.parent) vrm.scene.add(root);
  vrm.scene.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false; // bounds are the bind pose, not the animated one
    }
  });
  vrm.scene.updateMatrixWorld(true);
  return vrm;
}

export function vrmHeight(vrm) {
  const box = new THREE.Box3().setFromObject(vrm.scene);
  return box.max.y - box.min.y;
}

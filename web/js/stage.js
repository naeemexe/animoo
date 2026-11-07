// Renderer, camera, golden-hour light, sky and the diorama ground.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toonMaterial } from './toon.js';

export const GROUND_RADIUS = 18;

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, '#a9c7d8');
  grad.addColorStop(0.45, '#f3dcb2');
  grad.addColorStop(1.0, '#f0b98a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createGround() {
  const group = new THREE.Group();
  group.name = 'ground';

  // A round grass tile with a soil rim, like a tabletop diorama.
  const geo = new THREE.CylinderGeometry(GROUND_RADIUS, GROUND_RADIUS - 0.6, 1.6, 40, 1);
  const soil = toonMaterial('#9a6a45');
  const grass = toonMaterial('#93c05a');
  const island = new THREE.Mesh(geo, [soil, grass, soil]); // side, top, bottom
  island.position.y = -0.8;
  island.receiveShadow = true;
  group.add(island);

  // A few darker grass patches break up the flat green.
  const patchMat = toonMaterial('#7fb04b', { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const rng = mulberry32(7);
  for (let i = 0; i < 9; i++) {
    const r = 1.5 + rng() * 2.5;
    const patch = new THREE.Mesh(new THREE.CircleGeometry(r, 7), patchMat);
    const a = rng() * Math.PI * 2;
    const d = 3 + rng() * (GROUND_RADIUS - 6);
    patch.rotation.x = -Math.PI / 2;
    patch.rotation.z = rng() * Math.PI;
    patch.position.set(Math.cos(a) * d, 0.001, Math.sin(a) * d);
    patch.receiveShadow = true;
    group.add(patch);
  }
  return group;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createStage(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog('#f0cf9f', 70, 140);

  // High three-quarter view with a long lens: reads as a miniature.
  const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 1, 200);
  camera.position.set(34, 32, 34);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.minPolarAngle = 0.45;
  controls.maxPolarAngle = 1.15;
  controls.minDistance = 25;
  controls.maxDistance = 90;
  controls.update();

  // Golden-hour sun: warm, fairly low, from the left of the camera.
  const sun = new THREE.DirectionalLight('#ffd29a', 3.2);
  sun.position.set(-22, 26, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = -GROUND_RADIUS - 4;
  s.right = GROUND_RADIUS + 4;
  s.top = GROUND_RADIUS + 4;
  s.bottom = -GROUND_RADIUS - 4;
  s.near = 1;
  s.far = 90;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // Cool lilac sky fill keeps shadows coloured, warm bounce from the ground.
  const hemi = new THREE.HemisphereLight('#c6c3ec', '#c79a5e', 1.35);
  scene.add(hemi);

  const ground = createGround();
  scene.add(ground);

  // Keep the whole island in frame: pull back on narrow (portrait) windows.
  const baseOffset = camera.position.clone().sub(controls.target);
  function frame() {
    const k = Math.max(1, 1.5 / camera.aspect);
    camera.position.copy(controls.target).addScaledVector(baseOffset, k);
    controls.maxDistance = Math.max(90, baseOffset.length() * k * 1.3);
    controls.update();
    // Haze only beyond the island's far rim, wherever the camera sits.
    const dist = baseOffset.length() * k;
    scene.fog.near = dist + GROUND_RADIUS;
    scene.fog.far = dist + GROUND_RADIUS + 70;
  }

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    frame();
  }
  frame();

  return { renderer, scene, camera, controls, sun, hemi, ground, resize };
}

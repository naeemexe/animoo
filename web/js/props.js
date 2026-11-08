// Every library prop in a grid on the storybook stage, at real-world scale,
// next to a 1.7 m figure for reference. Open /props.html (add ?labels for ids).
import * as THREE from 'three';
import { createStage } from './stage.js';
import { createLook } from './look.js';
import { toonMaterial } from './toon.js';
import { loadManifest, loadProp } from './library.js';

const stage = createStage(document.getElementById('app'));
const look = createLook(stage.renderer, stage.scene, stage.camera);
look.setFocus({ point: stage.controls.target, blur: 0 }); // a catalog: all sharp
window.addEventListener('resize', () => {
  stage.resize();
  look.setSize(window.innerWidth, window.innerHeight);
});
const labels = [];
const tmp = new THREE.Vector3();
stage.renderer.setAnimationLoop(() => {
  stage.controls.update();
  look.render();
  for (const { el, obj, h } of labels) {
    tmp.set(0, h, 0).applyMatrix4(obj.matrixWorld).project(stage.camera);
    el.style.transform = `translate(-50%, -100%) translate(${(tmp.x + 1) * 50}vw, ${(1 - tmp.y) * 50}vh)`;
  }
});

// A plain 1.7 m figure, so scale reads at a glance.
function person() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.0, 4, 8), toonMaterial('#d9573f'));
  body.position.y = 0.72;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), toonMaterial('#f2c9a0'));
  head.position.y = 1.53;
  g.add(body, head);
  g.traverse((n) => { n.castShadow = n.receiveShadow = n.isMesh; });
  return g;
}

// Shelf packing: props in manifest order, rows up to ROW_W meters wide.
const ROW_W = 30;
const GAP = 0.8;
function layout(entries) {
  const spots = [];
  let x = 0, z = 0, rowDepth = 0;
  for (const e of entries) {
    const [w, , d] = e.size;
    if (x > 0 && x + w > ROW_W) { z += rowDepth + GAP; x = 0; rowDepth = 0; }
    spots.push({ x: x + w / 2, z: z + d / 2 });
    x += w + GAP;
    rowDepth = Math.max(rowDepth, d);
  }
  const depth = z + rowDepth;
  return spots.map((s) => ({ x: s.x - ROW_W / 2, z: s.z - depth / 2 }));
}

const status = document.getElementById('status');
const showLabels = new URLSearchParams(location.search).has('labels');
const manifest = await loadManifest();
// A reference figure opens each category, so every row has one.
const PERSON = { id: '1.7 m', size: [0.5, 1.7, 0.5], person: true };
const items = [];
for (const e of manifest.props) {
  if (!items.length || items.at(-1).category !== e.category) items.push({ ...PERSON, category: e.category });
  items.push(e);
}
const spots = layout(items);
const results = await Promise.allSettled(items.map((e) => (e.person ? person() : loadProp(e))));
const grid = new THREE.Group();
grid.name = 'prop-grid';
let failed = 0;
results.forEach((r, i) => {
  if (r.status === 'rejected') {
    failed++;
    console.error(`prop ${items[i].id} failed:`, r.reason);
    return;
  }
  r.value.position.set(spots[i].x, 0, spots[i].z);
  grid.add(r.value);
  if (showLabels) {
    const el = document.createElement('div');
    el.className = 'prop-label';
    el.textContent = items[i].id;
    document.body.appendChild(el);
    labels.push({ el, obj: r.value, h: items[i].size[1] });
  }
});
stage.scene.add(grid);

const total = manifest.props.length;
status.textContent = `${total - failed} of ${total} props loaded`;
status.className = failed ? 'pill bad' : 'pill ok';
window.animo = { stage, look, manifest, grid };

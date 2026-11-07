// A test village made only of primitives (boxes, spheres, cones), to judge the
// look before any library asset exists. Task 04 replaces this with agent output.
import * as THREE from 'three';
import { toonMaterial, faceted } from './toon.js';
import { mulberry32 } from './stage.js';

const C = {
  wall: '#f3e2c2',
  wallAlt: '#e9c99a',
  roof: '#cf5f3a',
  roofAlt: '#6f8fb8',
  trunk: '#86573a',
  leaf: '#5e9c3c',
  leafAlt: '#82b545',
  leafAutumn: '#e1a03a',
  rock: '#b9ad99',
  path: '#e6c891',
  water: '#7fc3d4',
  ball: '#f0c64a',
};

function mesh(geo, color, opts) {
  const m = new THREE.Mesh(geo, toonMaterial(color, opts));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function house(w, d, h, wall, roof) {
  const g = new THREE.Group();
  const body = mesh(new THREE.BoxGeometry(w, h, d), wall);
  body.position.y = h / 2;
  const roofH = Math.min(w, d) * 0.7;
  const r = mesh(faceted(new THREE.ConeGeometry(Math.max(w, d) * 0.78, roofH, 4, 1)), roof);
  r.rotation.y = Math.PI / 4;
  r.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d));
  r.position.y = h + roofH / 2;
  const door = mesh(new THREE.BoxGeometry(w * 0.22, h * 0.5, 0.08), '#7a4b2e');
  door.position.set(0, h * 0.25, d / 2 + 0.04);
  g.add(body, r, door);
  return g;
}

function tree(scale, leaf) {
  const g = new THREE.Group();
  const trunk = mesh(faceted(new THREE.CylinderGeometry(0.18, 0.26, 1.4, 6)), C.trunk);
  trunk.position.y = 0.7;
  const crown = mesh(faceted(new THREE.IcosahedronGeometry(1.1, 1)), leaf);
  crown.position.y = 2.1;
  const top = mesh(faceted(new THREE.IcosahedronGeometry(0.7, 1)), leaf);
  top.position.set(0.25, 2.9, 0.1);
  g.add(trunk, crown, top);
  g.scale.setScalar(scale);
  return g;
}

export function buildDemo(scene) {
  const village = new THREE.Group();
  village.name = 'demo-village';
  const rng = mulberry32(42);

  // Dirt path and a pond, sitting just above the grass.
  const path = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 30),
    toonMaterial(C.path, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  path.rotation.set(-Math.PI / 2, 0, 0.5);
  path.position.y = 0.002;
  path.receiveShadow = true;
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 9),
    toonMaterial(C.water, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(6, 0.003, 6);
  pond.receiveShadow = true;
  village.add(path, pond);

  const houses = [
    [-4, -3, 0.3, 3.2, 2.6, 2.4, C.wall, C.roof],
    [3, -6, -0.2, 2.6, 2.4, 2.0, C.wallAlt, C.roofAlt],
    [-8, 3, 0.9, 2.8, 3.0, 2.2, C.wall, C.roofAlt],
    [1, 2, -0.5, 2.2, 2.2, 1.9, C.wallAlt, C.roof],
    [-1, -10, 0.1, 3.0, 2.4, 2.6, C.wall, C.roof],
  ];
  for (const [x, z, ry, w, d, h, wall, roof] of houses) {
    const hs = house(w, d, h, wall, roof);
    hs.position.set(x, 0, z);
    hs.rotation.y = ry;
    village.add(hs);
  }

  const leaves = [C.leaf, C.leafAlt, C.leaf, C.leafAutumn];
  const trees = [[-10, -6], [-12, 1], [8, -2], [10, -8], [-5, 9], [3, 10], [11, 3], [-2, 5.5], [7, -11], [-13, -9]];
  trees.forEach(([x, z], i) => {
    const t = tree(0.8 + rng() * 0.6, leaves[i % leaves.length]);
    t.position.set(x, 0, z);
    t.rotation.y = rng() * Math.PI;
    village.add(t);
  });

  // Plain primitives too, so the shading is easy to judge.
  for (let i = 0; i < 6; i++) {
    const rock = mesh(faceted(new THREE.DodecahedronGeometry(0.4 + rng() * 0.4, 0)), C.rock);
    const a = rng() * Math.PI * 2, r = 6 + rng() * 8;
    rock.position.set(Math.cos(a) * r, 0.2, Math.sin(a) * r);
    rock.rotation.set(rng(), rng(), rng());
    village.add(rock);
  }
  const ball = mesh(new THREE.SphereGeometry(0.6, 24, 16), C.ball);
  ball.position.set(-1.5, 0.6, 1);
  const crate = mesh(new THREE.BoxGeometry(1, 1, 1), '#b98552');
  crate.position.set(4.6, 0.5, -2.5);
  crate.rotation.y = 0.4;
  const crate2 = crate.clone();
  crate2.position.set(5.3, 0.5, -1.4);
  crate2.rotation.y = -0.2;
  village.add(ball, crate, crate2);

  scene.add(village);
  return village;
}

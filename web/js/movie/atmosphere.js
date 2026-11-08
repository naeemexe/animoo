// Time of day + weather on top of the built set (task 17):
// - night (and a little at dusk): glowing windows on buildings, glowing
//   lanterns with soft halos, and a few warm point lights (at most 4);
// - a campfire flame that flickers, with its light at dusk and night;
// - rain streaks or snowflakes: one draw call each, moved in the vertex
//   shader, wrapped in a box in front of the camera so they follow it;
// - wind: a shared uniform the fill's grass and tree leaves sway with.
// The sky, haze and sun colors per time of day and weather live in
// fill.js (PALETTE) and world.js (LIGHT).
import * as THREE from 'three';

// Shared by every swaying material (fill.js): time and wind strength.
export const WIND = { uTime: { value: 0 }, uWind: { value: 0.25 } };
const WIND_BY_WEATHER = { clear: 0.25, fog: 0.1, snow: 0.35, rain: 0.7, windy: 1.4 };

// Sway a toon material's vertices with height above the ground (world y),
// after instancing, so every tuft and tree moves on its own phase.
export function addWind(material, stiffness = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = WIND.uTime;
    shader.uniforms.uWind = WIND.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace('#include <project_vertex>', /* glsl */ `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelMatrix * mvPosition;
        {
          float h = max(mvPosition.y, 0.0);
          float ph = mvPosition.x * 0.35 + mvPosition.z * 0.27;
          float gust = 0.6 + 0.4 * sin(uTime * 0.7 + mvPosition.x * 0.05);
          float s = uWind * gust * ${(0.12 / stiffness).toFixed(3)} * h * h / (1.0 + h);
          mvPosition.x += s * (0.8 + 0.35 * sin(uTime * 2.3 + ph));
          mvPosition.z += s * 0.35 * sin(uTime * 1.7 + ph * 1.3);
        }
        mvPosition = viewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  material.customProgramCacheKey = () => `wind${stiffness}`;
  return material;
}

// ---- per-frame updates -----------------------------------------------------

const live = new Set(); // atmosphere groups with something to animate

// 1 = shown, 0 = hidden, -1 = its set was removed from the scene.
function onStage(obj) {
  let o = obj, shown = 1;
  while (o) {
    if (!o.visible) shown = 0;
    if (o.isScene) return shown;
    o = o.parent;
  }
  return -1;
}

// Called once per frame from main.js.
export function tickAtmosphere(dt, camera) {
  WIND.uTime.value += dt;
  for (const g of live) {
    const on = onStage(g);
    if (on < 0) live.delete(g);
    if (on <= 0) continue;
    WIND.uWind.value = g.userData.wind;
    g.userData.tick(WIND.uTime.value, dt, camera);
  }
}

// Objects the outline's normal pass must skip (it renders everything with
// one override material, which would draw sprites and particles as solid).
function noNormalPass(scene, obj) {
  (scene.userData.noNormal ??= new Set()).add(obj);
}

// ---- glow -------------------------------------------------------------------

let haloTex = null;
function halo() {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,240,200,1)');
  grad.addColorStop(0.25, 'rgba(255,200,120,0.55)');
  grad.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  haloTex = new THREE.CanvasTexture(c);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  return haloTex;
}

function haloSprite(scene, size, color, opacity) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: halo(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  }));
  s.scale.setScalar(size);
  s.renderOrder = 3;
  noNormalPass(scene, s);
  return s;
}

const BUILDING = /house|cottage|hut|building|lighthouse|tower|cabin|inn|tavern|shop|mill|church|home/;
const LAMP = /lantern|lamp|street ?light|torch/;
const FIRE = /campfire|bonfire|fire ?pit|\bfire\b/;

const kind = (entry) => {
  const words = `${entry.id} ${(entry.tags ?? []).join(' ')}`;
  if (FIRE.test(words)) return 'fire';
  if (LAMP.test(words)) return 'lamp';
  if (/tent/.test(words) || entry.category === 'vehicles') return null;
  if (entry.category === 'buildings' || BUILDING.test(words)) return 'building';
  return null;
};

// Windows: rays from outside toward the building find its real walls, so a
// lit pane sits on the wall whatever the model's shape.
function findWindows(obj, rng) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const R = Math.max(size.x, size.z);
  const h = size.y;
  const meshes = [];
  obj.traverse((n) => { if (n.isMesh) meshes.push(n); });
  const ray = new THREE.Raycaster();
  const out = [];
  const levels = h > 4.5 ? [0.3, 0.55, 0.78] : [0.42];
  const rot = obj.rotation.y;
  for (let f = 0; f < 4; f++) {
    const a = rot + (f * Math.PI) / 2;
    const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const side = new THREE.Vector3(dir.z, 0, -dir.x);
    const width = f % 2 ? size.z : size.x;
    const spots = width > 3 && h <= 4.5 ? [-0.22, 0.22] : [0];
    for (const lv of levels) {
      for (const sp of spots) {
        if (rng() < 0.2) continue; // some rooms are dark
        const from = c.clone().addScaledVector(dir, R + 2).addScaledVector(side, sp * width);
        from.y = box.min.y + h * lv;
        ray.set(from, dir.clone().negate());
        ray.far = R + 2;
        const hit = ray.intersectObjects(meshes, false)[0];
        if (!hit?.face) continue;
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        n.y = 0;
        if (n.lengthSq() < 0.3) continue; // a roof or a slope, not a wall
        n.normalize();
        if (n.dot(dir) < 0.5) continue;
        out.push({ p: hit.point.clone().addScaledVector(n, 0.04), n, scale: h > 4.5 ? 0.8 : 1 });
      }
    }
  }
  return out;
}

// ---- rain and snow ------------------------------------------------------------

const BOX = new THREE.Vector3(56, 18, 56);

function precipitation(weather, scene) {
  const snow = weather === 'snow';
  const n = snow ? 5000 : 7000;
  const seeds = new Float32Array(n * (snow ? 3 : 6));
  const tips = new Float32Array(snow ? n : n * 2);
  for (let i = 0; i < n; i++) {
    const s = [Math.random(), Math.random(), Math.random()];
    if (snow) seeds.set(s, i * 3);
    else {
      seeds.set(s, i * 6);
      seeds.set(s, i * 6 + 3);
      tips[i * 2 + 1] = 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seeds.length), 3)); // unused, sizes the draw
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
  geo.setAttribute('tip', new THREE.BufferAttribute(tips, 1));
  const uniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: BOX },
    uSpeed: { value: snow ? 1.3 : 14 },
    uDrift: { value: new THREE.Vector2(snow ? 0.6 : 2.2, snow ? 0.2 : 0.8) },
    uLen: { value: 0.55 },
    uColor: { value: new THREE.Color(snow ? '#ffffff' : '#c9d6ea') },
    uAlpha: { value: snow ? 0.9 : 0.42 },
    uScale: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform float uTime, uSpeed, uLen, uScale;
      uniform vec3 uCenter, uBox;
      uniform vec2 uDrift;
      attribute vec3 seed;
      attribute float tip;
      varying float vFade;
      void main() {
        // Falls through a box that is fixed in the world and wraps around the
        // camera's view, so drops don't swim when the camera moves.
        vec3 vel = vec3(uDrift.x, -uSpeed, uDrift.y);
        vec3 p = seed * uBox + vel * uTime;
        ${snow ? 'p.x += sin(uTime * 0.9 + seed.y * 40.0) * 0.5; p.z += cos(uTime * 0.7 + seed.x * 40.0) * 0.5;' : ''}
        vec3 base = vec3(uCenter.x - uBox.x * 0.5, 0.0, uCenter.z - uBox.z * 0.5);
        vec3 w = base + mod(p - base, uBox);
        w -= normalize(vel) * uLen * tip;
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        vFade = smoothstep(1.5, 4.0, d) * (1.0 - smoothstep(30.0, 48.0, d));
        ${snow ? 'gl_PointSize = uScale * 0.09 * 900.0 / max(d, 1.0);' : ''}
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      varying float vFade;
      void main() {
        float a = uAlpha * vFade;
        ${snow ? 'vec2 q = gl_PointCoord - 0.5; a *= smoothstep(0.5, 0.2, length(q));' : ''}
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const obj = snow ? new THREE.Points(geo, mat) : new THREE.LineSegments(geo, mat);
  obj.frustumCulled = false;
  obj.renderOrder = 4;
  obj.name = snow ? 'snow' : 'rain';
  noNormalPass(scene, obj);
  const fwd = new THREE.Vector3();
  const pr = () => (window.devicePixelRatio > 1 ? Math.min(window.devicePixelRatio, 2) : 1);
  obj.userData.tick = (t, camera) => {
    uniforms.uTime.value = t;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    uniforms.uCenter.value.copy(camera.position).addScaledVector(fwd, BOX.x * 0.38);
    uniforms.uScale.value = pr();
  };
  return obj;
}

// ---- the whole atmosphere ---------------------------------------------------------

export function addAtmosphere(stage, script, set) {
  const t = script.terrain ?? {};
  const tod = t.time_of_day ?? 'golden';
  const weather = t.weather ?? 'clear';
  const night = tod === 'night' ? 1 : tod === 'dusk' ? 0.55 : 0;
  const g = new THREE.Group();
  g.name = 'atmosphere';
  g.userData.wind = WIND_BY_WEATHER[weather] ?? 0.25;
  const counts = { windows: 0, lamps: 0, fires: 0, lights: 0, weather };
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const props = set.children.filter((o) => o.userData.prop);
  const lights = []; // candidates: {pos, color, power, dist, rank}
  const flickers = [];

  // Campfires: a flame that always flickers, light only when it's dim out.
  for (const o of props.filter((p) => kind(p.userData.prop) === 'fire')) {
    counts.fires++;
    const flame = new THREE.Group();
    const top = new THREE.Box3().setFromObject(o).max.y;
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.75, 7, 1, true), new THREE.MeshBasicMaterial({ color: '#ff7a2a', fog: true }));
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.48, 6, 1, true), new THREE.MeshBasicMaterial({ color: '#ffd86a', fog: true }));
    outer.position.y = 0.37;
    inner.position.y = 0.26;
    flame.add(outer, inner);
    flame.position.set(o.position.x, top - 0.05, o.position.z);
    const glow = haloSprite(stage.scene, 2.6, '#ffb060', 0.35 + 0.5 * night);
    glow.position.set(o.position.x, top + 0.4, o.position.z);
    g.add(flame, glow);
    const L = { pos: new THREE.Vector3(o.position.x, top + 0.7, o.position.z), color: '#ff9a48', power: 30, dist: 14, rank: 0 };
    lights.push(L);
    flickers.push({ flame, glow, L, k: rng() * 10 });
  }

  if (night > 0) {
    // Lanterns: a bright head, a halo and maybe a light.
    for (const o of props.filter((p) => kind(p.userData.prop) === 'lamp')) {
      const box = new THREE.Box3().setFromObject(o);
      const y = box.min.y + (box.max.y - box.min.y) * 0.84;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshBasicMaterial({ color: '#fff0b8', fog: true }));
      head.position.set(o.position.x, y, o.position.z);
      const glow = haloSprite(stage.scene, 1.8, '#ffc870', 0.85 * night);
      glow.position.copy(head.position);
      g.add(head, glow);
      lights.push({ pos: head.position.clone(), color: '#ffc27a', power: 14, dist: 10, rank: 1 });
      counts.lamps++;
    }
    // Windows: lit panes on the walls, one instanced mesh, plus a soft glow.
    const panes = [];
    for (const o of props.filter((p) => kind(p.userData.prop) === 'building')) {
      const ws = findWindows(o, rng);
      panes.push(...ws);
      if (ws.length) {
        const w = ws[Math.floor(ws.length / 2)];
        lights.push({ pos: w.p.clone().addScaledVector(w.n, 1.2), color: '#ffb766', power: 8, dist: 8, rank: 2 });
      }
    }
    if (panes.length) {
      const pane = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.42, 0.55),
        new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffc86e').multiplyScalar(0.6 + 0.6 * night), fog: true }), panes.length);
      const aura = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({
        map: halo(), color: '#ffb35c', transparent: true, opacity: 0.55 * night, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
      }), panes.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), z = new THREE.Vector3(0, 0, 1);
      panes.forEach((w, i) => {
        q.setFromUnitVectors(z, w.n);
        pane.setMatrixAt(i, m.compose(w.p, q, s.setScalar(w.scale)));
        aura.setMatrixAt(i, m.compose(w.p.clone().addScaledVector(w.n, 0.05), q, s.setScalar(w.scale)));
      });
      pane.name = 'windows';
      aura.name = 'window-glow';
      aura.renderOrder = 3;
      noNormalPass(stage.scene, aura);
      g.add(pane, aura);
      counts.windows = panes.length;
    }
  }

  // At most 4 point lights: fires first, then the lamps and windows nearest
  // the middle of the action. Each costs every lit pixel a little.
  if (night > 0) {
    lights.sort((a, b) => a.rank - b.rank || a.pos.lengthSq() - b.pos.lengthSq());
    for (const L of lights.slice(0, 4)) {
      const p = new THREE.PointLight(L.color, L.power * night, L.dist, 2);
      p.position.copy(L.pos);
      L.light = p;
      g.add(p);
      counts.lights++;
    }
  }

  let precip = null;
  if ((weather === 'rain' || weather === 'snow') && !['room', 'restaurant'].includes(t.biome)) { // not indoors
    precip = precipitation(weather, stage.scene);
    g.add(precip);
  }

  g.userData.tick = (time, dt, camera) => {
    for (const f of flickers) {
      const n = 0.75 + 0.15 * Math.sin(time * 11 + f.k) + 0.1 * Math.sin(time * 23.7 + f.k * 2) + 0.08 * Math.sin(time * 5.3);
      f.flame.scale.set(1 + 0.08 * Math.sin(time * 9 + f.k), n * 1.1, 1 + 0.08 * Math.cos(time * 8 + f.k));
      f.flame.rotation.y = time * 0.8;
      f.glow.material.opacity = (0.35 + 0.5 * night) * (0.8 + 0.25 * n);
      if (f.L.light) f.L.light.intensity = f.L.power * night * (0.7 + 0.45 * n);
    }
    precip?.userData.tick(time, camera);
  };
  g.userData.counts = counts;
  live.add(g);
  return g;
}

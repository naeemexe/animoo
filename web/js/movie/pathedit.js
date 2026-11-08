// Path editor (task 30): camera paths and character paths drawn in the scene
// like a level editor. Each node is a numbered marker (a fixed-size sprite on
// top of everything) and the nodes are joined by a dotted line along the curve
// the camera or the character really follows. Drag a node to move it: a
// character node slides on the ground; a camera node slides at its height, and
// the selected camera node has a ↕ handle above it for its height.
//
// Camera paths are task 19's `camera_paths` (keys at times). Character paths are
//   walk_paths: [{ beat, cast, points: [[x, z], …] }]
// a walk beat that goes through the points (director.js bends the walk onto
// them) instead of its A* path. The editor only draws and edits; edit.js owns
// the buttons, the save and the re-direct.
import * as THREE from 'three';
import { samplePath } from './campath.js';
import { roundCorners } from './director.js';

const CAM = '#e64980', WALK = '#15aabf';
const r2 = (v) => Math.round(v * 100) / 100;

// ---- textures ------------------------------------------------------------------
const texCache = new Map();
function nodeTex(label, color, sel) {
  const key = `${label}|${color}|${sel}`;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (sel) { g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fillStyle = 'rgba(255,255,255,0.55)'; g.fill(); }
  g.beginPath(); g.arc(64, 64, 44, 0, 7);
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
  g.fillStyle = label === '' ? 'rgba(255,255,255,0.15)' : color; g.fill();
  g.shadowColor = 'transparent';
  g.lineWidth = 8; g.strokeStyle = '#fff'; g.stroke();
  if (label) {
    g.fillStyle = '#fff'; g.font = 'bold 50px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 64, 67);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}
let dotT = null;
function dotTex() {
  if (dotT) return dotT;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(16, 16, 12, 0, 7); g.fillStyle = '#fff'; g.fill();
  dotT = new THREE.CanvasTexture(c);
  return dotT;
}

// Points every `gap` m along a polyline of Vector3s.
function spaced(pts, gap) {
  const out = [pts[0].clone()];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], d = a.distanceTo(b);
    let s = gap - carry;
    while (s <= d) { out.push(a.clone().lerp(b, s / d)); s += gap; }
    carry = d - (s - gap);
  }
  return out;
}

export function createPathEditor(stage, { state, onCam, onWalk, onSelect }) {
  const group = new THREE.Group();
  group.name = 'path-editor';
  let nodes = []; // sprites with userData { kind, path|walk, index, handle }
  let sel = null; // { kind: 'cam', path, key } | { kind: 'walk', walk, index }
  let walkBeat = null; // the walk beat being edited
  let draft = null; // its path before the first edit (not in the script yet)
  let drag = null;
  let camPath = null; // the camera path the buttons act on (edit.js sets it)

  const px = (n) => (n / innerHeight) * 2 * Math.tan((stage.camera.fov * Math.PI) / 360); // screen px → sprite scale
  const walks = () => state.script.walk_paths ?? [];

  // The placed walk for a beat id: { castId, k, placed } (k: the character's scale).
  function walkInfo(beatId) {
    for (const [castId, row] of Object.entries(state.rows)) {
      const placed = row.beats.find((b) => b.beat.id === beatId && b.path);
      if (placed) return { castId, k: state.script.cast.find((c) => c.id === castId)?.scale ?? 1, placed };
    }
    return null;
  }
  // The walk beats you can draw a path for, for the dropdown.
  function walkBeats() {
    const out = [];
    for (const [castId, row] of Object.entries(state.rows)) {
      for (const b of row.beats) if (b.path) out.push({ id: b.beat.id, castId, label: `${castId} · ${b.beat.action ?? b.beat.id}`, start: b.start });
    }
    return out.sort((a, b) => a.start - b.start);
  }
  // The edited path for the current beat: the saved one, else a draft seeded from the planned walk.
  function currentWalk() {
    if (!walkBeat) return null;
    const saved = walks().find((w) => w.beat === walkBeat);
    if (saved) return saved;
    if (draft?.beat === walkBeat) return draft;
    const info = walkInfo(walkBeat);
    if (!info) return null;
    const pts = info.placed.path.map(([x, z]) => new THREE.Vector3(x * info.k, 0, z * info.k));
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    const n = THREE.MathUtils.clamp(Math.round(len / 2.5), 2, 4);
    const points = [];
    for (let i = 1; i <= n; i++) {
      let s = (len * i) / n, j = 1;
      while (j < pts.length - 1 && s > pts[j].distanceTo(pts[j - 1])) { s -= pts[j].distanceTo(pts[j - 1]); j++; }
      const d = pts[j].distanceTo(pts[j - 1]) || 1;
      const p = pts[j - 1].clone().lerp(pts[j], Math.min(1, s / d));
      points.push([r2(p.x), r2(p.z)]);
    }
    draft = { beat: walkBeat, cast: info.castId, points };
    return draft;
  }
  // Where the walk starts (the character's position when the beat begins).
  function walkStart(w) {
    const info = walkInfo(w.beat);
    return info ? [info.placed.path[0][0] * info.k, info.placed.path[0][1] * info.k] : null;
  }
  // A draft becomes a real path on its first edit.
  function adopt(w) {
    if (walks().includes(w)) return;
    (state.script.walk_paths ??= []).push(w);
    draft = null;
  }

  // ---- drawing --------------------------------------------------------------------
  function sprite(label, color, size, sel, data) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: nodeTex(label, color, sel), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, fog: false, toneMapped: false }));
    s.scale.setScalar(px(size));
    s.renderOrder = 22;
    s.userData = data ?? {};
    return s;
  }
  function dots(pts, color, size, opacity = 1) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: dotTex(), transparent: true, opacity, alphaTest: 0.3, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    const p = new THREE.Points(geo, m);
    p.renderOrder = 21;
    return p;
  }
  // A fine dotted line from a to b (thin GL lines get darkened by the storybook look).
  function dashes(a, b, color, opacity = 0.6) {
    return dots(spaced([a, b], 0.22), color, 4, opacity);
  }

  function draw() {
    clear();
    if (!state.script) return;
    // Camera paths: dots along the spline, a numbered node per key, a dashed stem to the ground.
    for (const p of state.script.camera_paths ?? []) {
      if (!p.keys.length) continue;
      const on = p === camPath;
      const keys = [...p.keys].sort((a, b) => a.t - b.t);
      if (keys.length > 1) {
        const line = [];
        for (let i = 0; i <= 160; i++) line.push(samplePath(p, keys[0].t + (keys.at(-1).t - keys[0].t) * i / 160).pos);
        group.add(dots(spaced(line, 0.35), CAM, on ? 10 : 7, on ? 1 : 0.55));
      }
      keys.forEach((k, i) => {
        const at = new THREE.Vector3(...k.pos);
        const isSel = sel?.kind === 'cam' && sel.key === k;
        group.add(dashes(at, new THREE.Vector3(at.x, 0, at.z), CAM, on ? 0.55 : 0.3));
        group.add(dots([new THREE.Vector3(at.x, 0.02, at.z)], CAM, 14, on ? 0.8 : 0.4));
        if (on) group.add(dashes(at, new THREE.Vector3(...k.look), CAM, 0.25));
        const s = sprite(String(i + 1), CAM, isSel ? 50 : on ? 40 : 30, isSel, { kind: 'cam', path: p, key: k });
        s.position.copy(at);
        group.add(s);
        if (isSel) {
          const h = sprite('↕', CAM, 34, false, { kind: 'cam', path: p, key: k, handle: true });
          h.position.copy(at);
          h.center.set(0.5, -0.95); // drawn just above the node, at a fixed screen offset
          group.add(h);
        }
      });
    }
    // Character paths: every drawn one dim, the current one bright, from the character's start.
    const cur = currentWalk();
    const list = [...walks()];
    if (cur && !list.includes(cur)) list.push(cur);
    for (const w of list) {
      const on = w === cur;
      const start = walkStart(w);
      if (!start) continue;
      const curve = roundCorners([start, ...w.points]).map(([x, z]) => new THREE.Vector3(x, 0.04, z));
      group.add(dots(spaced(curve, 0.28), WALK, on ? 10 : 7, on ? 1 : 0.5));
      if (on) {
        const s0 = sprite('', WALK, 30, false, {});
        s0.position.set(start[0], 0.04, start[1]);
        group.add(s0);
      }
      w.points.forEach(([x, z], i) => {
        const isSel = sel?.kind === 'walk' && sel.walk === w && sel.index === i;
        const s = sprite(String(i + 1), WALK, isSel ? 50 : on ? 40 : 28, isSel, { kind: 'walk', walk: w, index: i });
        s.position.set(x, 0.04, z);
        group.add(s);
      });
    }
    nodes = group.children.filter((o) => o.isSprite && o.userData.kind);
    stage.scene.add(group);
  }
  function clear() {
    stage.scene.remove(group);
    for (const o of [...group.children]) { group.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    nodes = [];
  }

  // ---- picking and dragging ----------------------------------------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function aimAt(e) {
    const r = stage.renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);
  }
  // The node under the pointer (handles first, then the nearest).
  function hit(e) {
    if (!nodes.length) return null;
    aimAt(e);
    const hits = ray.intersectObjects(nodes, false);
    return (hits.find((h) => h.object.userData.handle) ?? hits[0])?.object.userData ?? null;
  }
  function onPlane(plane) {
    const v = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, v) ? v : null;
  }
  // The ground point under the pointer.
  function ground(e) { aimAt(e); return onPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)); }

  function select(d) {
    sel = d ? (d.kind === 'cam' ? { kind: 'cam', path: d.path, key: d.key } : { kind: 'walk', walk: d.walk, index: d.index }) : null;
    if (sel?.kind === 'cam') camPath = sel.path;
    onSelect(sel);
    draw();
  }

  // pointerdown: start dragging a node. Returns true if the pointer was on one.
  function down(e) {
    if (e.button !== 0) return false;
    const d = hit(e);
    if (!d) return false;
    select(d);
    if (d.kind === 'walk') drag = { d, plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), moved: false };
    else {
      const at = new THREE.Vector3(...d.key.pos);
      const plane = d.handle
        ? new THREE.Plane().setFromNormalAndCoplanarPoint(stage.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize().negate(), at)
        : new THREE.Plane(new THREE.Vector3(0, 1, 0), -at.y);
      const p0 = onPlane(plane) ?? at;
      drag = { d, plane, off: p0.sub(at), moved: false };
    }
    stage.renderer.domElement.style.cursor = 'grabbing';
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    return true;
  }
  function move(e) {
    if (!drag) return;
    aimAt(e);
    const p = onPlane(drag.plane);
    if (!p) return;
    drag.moved = true;
    const { d } = drag;
    if (d.kind === 'walk') {
      d.walk.points[d.index] = [r2(p.x), r2(p.z)];
    } else if (d.handle) {
      d.key.pos[1] = r2(Math.max(0.3, p.y - drag.off.y));
    } else {
      d.key.pos[0] = r2(p.x - drag.off.x);
      d.key.pos[2] = r2(p.z - drag.off.z);
    }
    draw();
  }
  function up() {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    stage.renderer.domElement.style.cursor = '';
    const dr = drag;
    drag = null;
    if (!dr?.moved) return;
    const { d } = dr;
    if (d.kind === 'walk') {
      adopt(d.walk);
      onWalk(`${d.walk.beat}: point ${d.index + 1} → (${d.walk.points[d.index].join(', ')})`);
    } else onCam(d.path, `key ${d.key.t.toFixed(1)} s ${d.handle ? `height → ${d.key.pos[1]} m` : `moved → (${d.key.pos.join(', ')})`}`);
  }
  function hover(e) {
    if (drag || e.buttons) return;
    const d = hit(e);
    stage.renderer.domElement.style.cursor = d ? (d.handle ? 'ns-resize' : 'grab') : '';
  }

  // Add a character point where the ground was clicked, in the segment it lengthens least.
  function addWalkPoint(e) {
    const w = currentWalk();
    const p = ground(e);
    if (!w || !p) return false;
    const start = walkStart(w);
    const pts = [start, ...w.points];
    const q = [r2(p.x), r2(p.z)];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    // Past the last point → append; else insert where it adds the least length.
    let best = pts.length, cost = dist(pts.at(-1), q);
    for (let i = 1; i < pts.length; i++) {
      const c = dist(pts[i - 1], q) + dist(q, pts[i]) - dist(pts[i - 1], pts[i]);
      if (c < cost) { cost = c; best = i; }
    }
    w.points.splice(best - 1, 0, q);
    adopt(w);
    sel = { kind: 'walk', walk: w, index: best - 1 };
    onSelect(sel);
    onWalk(`${w.beat}: point ${best} added at (${q.join(', ')})`);
    return true;
  }

  // Delete the selected node. Returns true if there was one.
  function deleteSelected() {
    if (!sel) return false;
    if (sel.kind === 'walk') {
      const w = sel.walk;
      w.points.splice(sel.index, 1);
      sel = null;
      if (!w.points.length) {
        const list = walks();
        if (list.includes(w)) list.splice(list.indexOf(w), 1);
        if (!list.length) delete state.script.walk_paths;
        draft = null;
        onWalk(`${w.beat}: last point deleted, back to the planned walk`);
      } else { adopt(w); onWalk(`${w.beat}: point deleted (${w.points.length} left)`); }
    } else {
      const { path, key } = sel;
      path.keys.splice(path.keys.indexOf(key), 1);
      sel = null;
      onCam(path, `key at ${key.t.toFixed(1)} s deleted`);
    }
    onSelect(null);
    return true;
  }

  // Remove the current character path (the walk goes back to its A* path).
  function clearWalk() {
    const w = currentWalk();
    draft = null;
    sel = null;
    const list = walks();
    if (!w || !list.includes(w)) { draw(); return; }
    list.splice(list.indexOf(w), 1);
    if (!list.length) delete state.script.walk_paths;
    onWalk(`${w.beat}: drawn path removed, back to the planned walk`);
  }

  return {
    draw, clear, hit, down, hover, addWalkPoint, deleteSelected, clearWalk, walkBeats,
    select,
    get dragging() { return !!drag; },
    get selected() { return sel; },
    get walkBeat() { return walkBeat; },
    set walkBeat(id) { walkBeat = id || null; draft = null; if (sel?.kind === 'walk') sel = null; draw(); },
    get walk() { return currentWalk(); },
    set camPath(p) { camPath = p; },
  };
}

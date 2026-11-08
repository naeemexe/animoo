// Edit mode for the Movie page (task 18): a toggle that pauses the film and
// hands the camera to orbit controls, then lets you click a prop to select it,
// move / rotate / scale it with a gizmo, duplicate, delete, swap it for another
// library prop, or regenerate it on the GPU with a new seed. Every change is
// written into the scene script (state.script.props); "Save" stores the props
// in the scene's cache file (POST /api/movie/script), so the next replay of the
// scene uses them. Leaving edit mode re-directs the film around the new set.
//
// Camera paths (task 19): scrub the timeline, "start here" / "end here" set a
// span, "add key" stores the current orbit view (camera position + target) at
// the playhead; campath.js runs a spline through the keys, which overrides the
// director for that span. The path is drawn in the scene while editing,
// "preview" flies it, and "save" stores it with the props.
//
// With the toggle off nothing here runs: no gizmo, no listeners on the canvas.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { generateProp, loadManifest, loadProp } from '../library.js';
import { API_BASE } from '../api.js';
import { samplePath } from './campath.js';

const RAD = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;

export function createEditor(root, stage, { state, log, onEnter, onExit, onScriptChanged, onPathsChanged, seek }) {
  const bar = document.createElement('div');
  bar.className = 'card edit-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <label class="edit-toggle"><input type="checkbox" class="ed-on"> edit set</label>
    <div class="ed-tools" hidden>
      <div class="ed-row">
        <button type="button" data-mode="translate" title="move (1)">move</button>
        <button type="button" data-mode="rotate" title="rotate (2)">rotate</button>
        <button type="button" data-mode="scale" title="scale (3)">scale</button>
      </div>
      <div class="ed-row">
        <button type="button" class="ed-dup" title="duplicate (Ctrl+D)">duplicate</button>
        <button type="button" class="ed-del" title="delete (Del)">delete</button>
      </div>
      <div class="ed-row">
        <select class="ed-lib" title="replace with a library item"><option value="">replace with…</option></select>
      </div>
      <div class="ed-row">
        <button type="button" class="ed-regen" title="generate_prop with a new seed (GPU)">regenerate</button>
        <button type="button" class="ed-save primary">save</button>
      </div>
      <div class="ed-status pill">click a prop</div>
      <div class="ed-head">camera path</div>
      <div class="ed-prow">
        <button type="button" class="ed-ps" title="the path starts at the playhead">start here</button>
        <button type="button" class="ed-pe" title="the path ends at the playhead">end here</button>
      </div>
      <div class="ed-prow">
        <button type="button" class="ed-pk" title="a key from the current view at the playhead (K)">add key</button>
        <button type="button" class="ed-pv" title="fly the path">preview</button>
        <button type="button" class="ed-pc" title="remove this path">clear</button>
      </div>
      <div class="ed-pstatus pill">scrub to a time, then "start here"</div>
    </div>`;
  root.appendChild(bar);
  const $ = (s) => bar.querySelector(s);
  const ui = { on: $('.ed-on'), tools: $('.ed-tools'), lib: $('.ed-lib'), status: $('.ed-status'), save: $('.ed-save'), regen: $('.ed-regen'), pstatus: $('.ed-pstatus') };

  const gizmo = new TransformControls(stage.camera, stage.renderer.domElement);
  gizmo.setSize(0.8);
  gizmo.addEventListener('dragging-changed', (e) => { stage.controls.enabled = !e.value; if (!e.value) commit(); });
  gizmo.addEventListener('objectChange', () => {
    const o = gizmo.object;
    if (!o) return;
    o.position.y = 0; // props stay on the ground
    if (gizmo.mode === 'scale') o.scale.setScalar(THREE.MathUtils.clamp(o.scale.y, 0.2, 5)); // one handle, uniform
    if (gizmo.mode === 'rotate') o.rotation.set(0, o.rotation.y, 0);
  });
  let helper = null; // the gizmo's root (r160 adds TransformControls itself to the scene)
  let selected = null; // { obj, p }
  let dirty = false; // set changed since entering (re-direct on exit)
  let unsaved = false;

  const status = (text, err = false) => { ui.status.textContent = text; ui.status.className = `ed-status pill${err ? ' bad' : ''}`; };

  // Top-level set objects that are the script's props, by key.
  function propObjects() {
    const keys = new Set(state.script.props.map((p) => p.key));
    return state.set.children.filter((o) => o.userData.prop && keys.has(o.name));
  }
  const propOf = (obj) => state.script.props.find((p) => p.key === obj.name);

  function select(obj) {
    selected = obj ? { obj, p: propOf(obj) } : null;
    if (obj) gizmo.attach(obj); else gizmo.detach();
    bar.querySelectorAll('.ed-row button, .ed-lib').forEach((b) => { if (b !== ui.save) b.disabled = !obj; });
    if (obj) {
      const p = selected.p;
      ui.lib.value = '';
      status(`${p.key} · ${p.library} · (${p.position.join(', ')}) · ${p.rotation ?? 0}° · ×${p.scale ?? 1}`);
    } else status('click a prop');
    setMode(gizmo.mode);
  }

  function setMode(mode) {
    gizmo.setMode(mode);
    gizmo.showY = mode !== 'translate';
    gizmo.showX = gizmo.showZ = mode !== 'rotate';
    if (mode === 'scale') { gizmo.showX = gizmo.showZ = false; gizmo.showY = true; } // uniform scale on one handle
    bar.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }

  // Write the selected object's transform into its script entry.
  function commit() {
    if (!selected) return;
    const { obj, p } = selected;
    p.position = [r2(obj.position.x), r2(obj.position.z)];
    const deg = Math.round(THREE.MathUtils.euclideanModulo(obj.rotation.y / RAD + 180, 360) - 180);
    if (deg) p.rotation = deg; else delete p.rotation;
    const s = r2(obj.scale.x);
    if (Math.abs(s - 1) > 0.005) p.scale = s; else delete p.scale;
    changed(`${p.key} → (${p.position.join(', ')}) · ${p.rotation ?? 0}° · ×${p.scale ?? 1}`);
  }

  function changed(line) {
    dirty = true;
    markUnsaved();
    if (selected) status(line);
    log('world', 'call', `edit: ${line}`);
    onScriptChanged();
  }
  function markUnsaved() {
    unsaved = true;
    ui.save.textContent = 'save*';
  }

  // ---- camera paths (task 19) --------------------------------------------------
  let curPath = null; // the path the buttons act on
  const paths = () => (state.script.camera_paths ??= []);
  const r1 = (v) => Math.round(v * 100) / 100;
  // The path under the playhead, else the one last touched.
  function current() {
    const list = state.script.camera_paths ?? [];
    curPath = list.find((p) => state.t >= p.start && state.t <= p.end) ?? (list.includes(curPath) ? curPath : null);
    return curPath;
  }
  function newPath(start, end) {
    curPath = { start: r1(start), end: r1(end), keys: [] };
    paths().push(curPath);
    return curPath;
  }
  function pathChanged(line) {
    const p = curPath;
    if (p) p.keys = p.keys.filter((k) => k.t >= p.start - 1e-3 && k.t <= p.end + 1e-3).sort((a, b) => a.t - b.t);
    if (!paths().length) delete state.script.camera_paths;
    markUnsaved();
    log('director', 'call', `camera path: ${line}`);
    pathStatus();
    drawPath();
    onScriptChanged();
    onPathsChanged();
  }
  function pathStatus() {
    const p = current();
    ui.pstatus.textContent = p
      ? `path ${p.start.toFixed(1)}–${p.end.toFixed(1)} s · ${p.keys.length} key${p.keys.length === 1 ? '' : 's'}${p.keys.length ? '' : ' (fly to a view, "add key")'}`
      : `no path at ${state.t.toFixed(1)} s: scrub, then "start here"`;
  }
  function setStart() {
    const t = state.t, p = current();
    if (p && t < p.end - 0.2) p.start = r1(t);
    else newPath(t, Math.min(t + 4, state.duration));
    pathChanged(`start ${curPath.start.toFixed(1)} s`);
  }
  function setEnd() {
    const t = state.t, p = current();
    if (p && t > p.start + 0.2) p.end = r1(t);
    else newPath(Math.max(0, t - 4), t);
    pathChanged(`end ${curPath.end.toFixed(1)} s`);
  }
  function addKey() {
    const t = r1(state.t);
    const p = current() ?? newPath(t, Math.min(t + 4, state.duration));
    if (t < p.start) p.start = t;
    if (t > p.end) p.end = t;
    const c = stage.camera.position, l = stage.controls.target;
    const key = { t, pos: [r1(c.x), r1(c.y), r1(c.z)], look: [r1(l.x), r1(l.y), r1(l.z)] };
    p.keys = p.keys.filter((k) => Math.abs(k.t - t) > 0.05);
    p.keys.push(key);
    pathChanged(`key at ${t.toFixed(1)} s from (${key.pos.join(', ')}) → (${key.look.join(', ')})`);
  }
  function clearPath() {
    const p = current();
    if (!p) return;
    paths().splice(paths().indexOf(p), 1);
    curPath = null;
    pathChanged(`removed ${p.start.toFixed(1)}–${p.end.toFixed(1)} s`);
  }

  // The path in the scene while editing: a line through the spline, a dot per key.
  let pathGroup = null;
  function drawPath() {
    if (pathGroup) { stage.scene.remove(pathGroup); pathGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
    pathGroup = new THREE.Group();
    pathGroup.name = 'camera-paths';
    for (const p of state.script.camera_paths ?? []) {
      if (!p.keys.length) continue;
      const on = p === curPath;
      const color = on ? 0xd6336c : 0x9a6b85;
      const t0 = p.keys[0].t, t1 = p.keys.at(-1).t;
      const pts = [];
      for (let i = 0; i <= 60; i++) pts.push(samplePath(p, t0 + (t1 - t0) * i / 60).pos);
      pathGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false })));
      for (const k of p.keys) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(on ? 0.22 : 0.16, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
        dot.position.set(...k.pos);
        pathGroup.add(dot);
        const aim = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...k.pos), new THREE.Vector3(...k.look)]),
          new THREE.LineDashedMaterial({ color, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.5, depthTest: false }));
        aim.computeLineDistances();
        pathGroup.add(aim);
      }
    }
    pathGroup.renderOrder = 10;
    pathGroup.traverse((o) => { o.renderOrder = 10; });
    stage.scene.add(pathGroup);
  }
  function hidePath() { if (pathGroup) { stage.scene.remove(pathGroup); pathGroup = null; } }

  // Fly the path once (the characters play along), then come back to the orbit view.
  let previewing = false;
  function preview() {
    const p = current();
    if (!p?.keys.length || previewing) return;
    previewing = true;
    const cam = stage.camera, from = cam.position.clone(), target = stage.controls.target.clone(), t0 = state.t;
    stage.controls.enabled = false;
    if (pathGroup) pathGroup.visible = false;
    let t = p.start, last = performance.now();
    const step = (now) => {
      t = Math.min(p.end, t + (now - last) / 1000);
      last = now;
      seek(t);
      const { pos, look } = samplePath(p, t);
      cam.position.copy(pos);
      stage.controls.target.copy(look); // the page's orbit update looks here too
      cam.lookAt(look);
      if (t < p.end && ui.on.checked) return requestAnimationFrame(step);
      previewing = false;
      seek(t0);
      cam.position.copy(from);
      stage.controls.target.copy(target);
      stage.controls.enabled = true;
      stage.controls.update();
      if (pathGroup) pathGroup.visible = true;
    };
    requestAnimationFrame(step);
  }

  function uniqueKey(base) {
    const keys = new Set(state.script.props.map((p) => p.key));
    const stem = base.replace(/-\d+$/, '');
    for (let i = 2; ; i++) if (!keys.has(`${stem}-${i}`)) return `${stem}-${i}`;
  }

  function duplicate() {
    if (!selected) return;
    const { obj, p } = selected;
    const copy = obj.clone(true);
    const q = structuredClone(p);
    q.key = uniqueKey(p.key);
    copy.name = q.key;
    copy.position.x += 1.5;
    q.position = [r2(copy.position.x), r2(copy.position.z)];
    state.set.add(copy);
    state.script.props.push(q);
    select(copy);
    changed(`duplicate(${p.key}) → ${q.key} at (${q.position.join(', ')})`);
  }

  function remove() {
    if (!selected) return;
    const { obj, p } = selected;
    select(null);
    state.set.remove(obj);
    state.script.props.splice(state.script.props.indexOf(p), 1);
    changed(`delete(${p.key})`);
  }

  // Swap the selected prop's model, keeping its key and transform.
  async function swapTo(id, line) {
    const { obj, p } = selected;
    const fresh = await loadProp(id);
    fresh.position.copy(obj.position);
    fresh.rotation.y = obj.rotation.y;
    fresh.scale.multiplyScalar(obj.scale.x);
    fresh.name = p.key;
    state.set.remove(obj);
    state.set.add(fresh);
    p.library = id;
    delete p.generate;
    select(fresh);
    changed(line);
  }

  async function replace(id) {
    if (!selected || !id) return;
    const from = selected.p.library;
    try {
      await swapTo(id, `replace(${selected.p.key}: ${from} → ${id})`);
    } catch (err) {
      status(`replace failed: ${err.message}`, true);
    }
  }

  // generate_prop's size_m, as server/tools/generate_prop.py fit_size reads it: the longest
  // side for long, low things (benches, boats, carts…), the height for everything else.
  const LENGTHWISE = /\b(boat|canoe|raft|ship|cart|wagon|car|truck|bus|bridge|dock|pier|jetty|bench|log|fence|table)s?\b/;
  function sizeFor(entry, text) {
    if (!entry.size) return undefined;
    const long = ['vehicles', 'water'].includes(entry.category) || LENGTHWISE.test(text.toLowerCase());
    return long ? Math.max(...entry.size) : entry.size[1];
  }

  // generate_prop with a new seed under a new id (the library keeps the old one).
  async function regenerate() {
    if (!selected) return;
    const { p } = selected;
    const m = await loadManifest();
    const entry = m.props.find((e) => e.id === p.library) ?? {};
    const base = p.library.replace(/-s\d+$/, '');
    const seed = 1 + Math.floor(Math.random() * 9999);
    const prompt = entry.prompt ?? p.generate?.prompt ?? base.replace(/-/g, ' ');
    ui.regen.disabled = true;
    status(`regenerating ${p.key} on the GPU (seed ${seed}), about 45 s…`);
    log('world', 'call', `generate_prop('${base}-s${seed}', "${prompt}", seed=${seed}) · concept image → TRELLIS.2`);
    try {
      const r = await generateProp({ name: `${base}-s${seed}`, prompt, size_m: sizeFor(entry, `${base} ${prompt}`), category: entry.category, seed });
      if (selected?.p !== p) { status(`${r.entry.id} is in the library; the prop was deselected, so nothing was swapped`); return; }
      await swapTo(r.entry.id, `regenerate(${p.key}) → ${r.entry.id} in ${Math.round(r.seconds)} s`);
      fillLibrary();
    } catch (err) {
      const down = /tunnel|unreachable|refused|timed out|503|connect/i.test(err.message);
      status(down ? 'The GPU is not reachable right now (tunnel down?), so the prop can\'t be regenerated. Replace it from the library instead.' : `regenerate failed: ${err.message}`, true);
      log('world', 'error', `generate_prop failed: ${err.message}`, { err: true });
    } finally {
      ui.regen.disabled = !selected;
    }
  }

  async function save() {
    ui.save.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/api/movie/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene: state.script.scene ?? state.scene, props: state.script.props, camera_paths: (state.script.camera_paths ?? []).filter((p) => p.keys.length) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? `save returned ${res.status}`);
      unsaved = false;
      ui.save.textContent = 'save';
      status(`saved ${state.script.props.length} props${body.camera_paths ? ` and ${body.camera_paths} camera path${body.camera_paths > 1 ? 's' : ''}` : ''} into library/scripts/${body.file}`);
      log('world', 'result', `edits saved to library/scripts/${body.file}`);
    } catch (err) {
      status(`save failed: ${err.message}`, true);
    } finally {
      ui.save.disabled = false;
    }
  }

  async function fillLibrary() {
    const m = await loadManifest();
    const byCat = new Map();
    for (const e of m.props) {
      if (e.file?.startsWith('procedural:') && !e.tags) continue;
      if (!byCat.has(e.category)) byCat.set(e.category, []);
      byCat.get(e.category).push(e);
    }
    ui.lib.innerHTML = '<option value="">replace with…</option>' + [...byCat].sort().map(([cat, list]) =>
      `<optgroup label="${cat}">${list.map((e) => `<option value="${e.id}">${e.id}${e.source === 'generated' ? ' ✦' : ''}</option>`).join('')}</optgroup>`).join('');
  }

  // ---- picking ---------------------------------------------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  function onDown(e) { down = [e.clientX, e.clientY]; }
  function onUp(e) {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || gizmo.dragging || gizmo.axis) { down = null; return; }
    down = null;
    const r = stage.renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, stage.camera);
    const objs = propObjects();
    const hit = ray.intersectObjects(objs, true)[0];
    let o = hit?.object;
    while (o && !objs.includes(o)) o = o.parent;
    select(o ?? null);
  }
  function onKey(e) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    // W/A/S/D/Q/E fly the free camera (task 29), so the gizmo modes are on 1/2/3.
    if (k === '1') setMode('translate');
    else if (k === '2') setMode('rotate');
    else if (k === '3') setMode('scale');
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); remove(); }
    else if (k === 'd' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicate(); }
    else if (k === 'escape') select(null);
    else if (k === 'k') addKey();
  }

  // A high three-quarter view over the props, so every one of them can be clicked.
  function frameSet() {
    const pts = state.script.props.map((p) => p.position);
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(8, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    const d = THREE.MathUtils.clamp(span * 1.9, 14, 64);
    // Center the set in the part of the screen the agent panel doesn't cover.
    const cam = stage.camera, w = innerWidth;
    const panel = document.querySelector('#page-movie .movie-panel')?.getBoundingClientRect().right ?? 0;
    const halfW = Math.tan((cam.fov * RAD) / 2) * cam.aspect * d * 1.06;
    const sx = cx - (panel / 2) * ((2 * halfW) / w);
    stage.controls.target.set(sx, 0, cz);
    cam.position.set(sx, d * 0.75, cz + d * 0.75);
    stage.controls.update();
  }

  function enter() {
    onEnter();
    frameSet();
    dirty = false;
    helper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
    stage.scene.add(helper);
    const el = stage.renderer.domElement;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    addEventListener('keydown', onKey);
    ui.tools.hidden = false;
    fillLibrary();
    select(null);
    setMode('translate');
    curPath = null;
    pathStatus();
    drawPath();
    log('world', 'note', 'edit mode: fly with W/A/S/D (Q/E down/up, Shift faster), drag or right-drag to look, wheel to dolly, middle-drag to pan; click a prop; 1/2/3 move/rotate/scale, Ctrl+D duplicate, Del delete; camera path: scrub, "start here", fly to a view, K adds a key');
  }
  function exit() {
    select(null);
    hidePath();
    if (helper) stage.scene.remove(helper);
    const el = stage.renderer.domElement;
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointerup', onUp);
    removeEventListener('keydown', onKey);
    stage.controls.enabled = true;
    ui.tools.hidden = true;
    onExit(dirty);
    if (unsaved) log('world', 'note', 'the set has unsaved edits (they play now, but a reload brings back the saved props)');
  }

  ui.on.onchange = () => (ui.on.checked ? enter() : exit());
  bar.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  $('.ed-dup').onclick = duplicate;
  $('.ed-del').onclick = remove;
  ui.lib.onchange = () => replace(ui.lib.value);
  ui.regen.onclick = regenerate;
  ui.save.onclick = save;
  $('.ed-ps').onclick = setStart;
  $('.ed-pe').onclick = setEnd;
  $('.ed-pk').onclick = addKey;
  $('.ed-pc').onclick = clearPath;
  $('.ed-pv').onclick = preview;

  return {
    get on() { return ui.on.checked; },
    canLook() { return !gizmo.axis && !gizmo.dragging && !previewing; }, // a left-drag that isn't on the gizmo
    show(ready) { bar.hidden = !ready; },
    timeChanged() { if (ui.on.checked && !previewing) pathStatus(); },
    off() { if (ui.on.checked) { ui.on.checked = false; exit(); } },
    reset() { this.off(); unsaved = false; ui.save.textContent = 'save'; bar.hidden = true; },
  };
}

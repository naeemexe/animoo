// Edit mode for the Movie page (task 18): a toggle that pauses the film and
// hands the camera to orbit controls, then lets you click a prop to select it,
// move / rotate / scale it with a gizmo, duplicate, delete, swap it for another
// library prop, or regenerate it on the GPU with a new seed. Every change is
// written into the scene script (state.script.props); "Save" stores the props
// in the scene's cache file (POST /api/movie/script), so the next replay of the
// scene uses them. Leaving edit mode re-directs the film around the new set.
//
// With the toggle off nothing here runs: no gizmo, no listeners on the canvas.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { generateProp, loadManifest, loadProp } from '../library.js';
import { API_BASE } from '../api.js';

const RAD = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;

export function createEditor(root, stage, { state, log, onEnter, onExit, onScriptChanged }) {
  const bar = document.createElement('div');
  bar.className = 'card edit-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <label class="edit-toggle"><input type="checkbox" class="ed-on"> edit set</label>
    <div class="ed-tools" hidden>
      <div class="ed-row">
        <button type="button" data-mode="translate" title="move (W)">move</button>
        <button type="button" data-mode="rotate" title="rotate (E)">rotate</button>
        <button type="button" data-mode="scale" title="scale (R)">scale</button>
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
    </div>`;
  root.appendChild(bar);
  const $ = (s) => bar.querySelector(s);
  const ui = { on: $('.ed-on'), tools: $('.ed-tools'), lib: $('.ed-lib'), status: $('.ed-status'), save: $('.ed-save'), regen: $('.ed-regen') };

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
    dirty = unsaved = true;
    ui.save.textContent = 'save*';
    if (selected) status(line);
    log('world', 'call', `edit: ${line}`);
    onScriptChanged();
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
      const r = await generateProp({ name: `${base}-s${seed}`, prompt, size_m: entry.size?.[1], category: entry.category, seed });
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
        body: JSON.stringify({ scene: state.script.scene ?? state.scene, props: state.script.props }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? `save returned ${res.status}`);
      unsaved = false;
      ui.save.textContent = 'save';
      status(`saved ${state.script.props.length} props into library/scripts/${body.file}`);
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
    if (k === 'w') setMode('translate');
    else if (k === 'e') setMode('rotate');
    else if (k === 'r') setMode('scale');
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); remove(); }
    else if (k === 'd' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicate(); }
    else if (k === 'escape') select(null);
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
    log('world', 'note', 'edit mode: click a prop; W/E/R move/rotate/scale, Ctrl+D duplicate, Del delete');
  }
  function exit() {
    select(null);
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

  return {
    get on() { return ui.on.checked; },
    show(ready) { bar.hidden = !ready; },
    off() { if (ui.on.checked) { ui.on.checked = false; exit(); } },
    reset() { this.off(); unsaved = false; ui.save.textContent = 'save'; bar.hidden = true; },
  };
}

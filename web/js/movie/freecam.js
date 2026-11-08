// Free spectator camera (task 29), like a game's free cam: W/A/S/D fly
// (W/S along the view, A/D sideways), Q/E down/up, Shift faster; right-drag,
// or left-drag where nothing else wants the click, turns the view; the wheel
// dollies along the view; middle-drag pans.
//
// It drives stage.camera directly and keeps stage.controls.target a point
// straight ahead, so anything that reads the orbit target (the look's focus,
// edit mode's "add key") sees the free camera's view. While it is on, the
// orbit controls' own mouse input is off (their angle and distance limits
// would fight free flying) and the page does not call controls.update().
// Off, nothing here listens or runs.
import * as THREE from 'three';

const LOOK = 0.0035; // rad per pixel
const PAN = 0.02; // m per pixel
const SPEED = 7; // m/s; Shift ×3
const PITCH = 85 * Math.PI / 180;
const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'shift']);

export function createFreeCam(stage, { canLook = () => true } = {}) {
  const cam = stage.camera, controls = stage.controls, el = stage.renderer.domElement;
  const keys = new Set();
  const vel = new THREE.Vector3();
  let active = false;
  let drag = null; // { mode: 'look' | 'pan', x, y }
  let saved = null; // orbit input flags to put back

  const dirOf = () => controls.target.clone().sub(cam.position);
  const dist = () => THREE.MathUtils.clamp(dirOf().length(), 4, 40);

  function aim(dir, d = dist()) {
    controls.target.copy(cam.position).addScaledVector(dir.normalize(), d);
    cam.lookAt(controls.target);
  }

  function look(dx, dy) {
    const d = dist(), dir = dirOf().normalize();
    let yaw = Math.atan2(dir.x, dir.z), pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    yaw -= dx * LOOK;
    pitch = THREE.MathUtils.clamp(pitch - dy * LOOK, -PITCH, PITCH);
    aim(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)), d);
  }

  function move(delta) {
    cam.position.add(delta);
    controls.target.add(delta);
    if (cam.position.y < 0.3) { const up = 0.3 - cam.position.y; cam.position.y += up; controls.target.y += up; }
    cam.lookAt(controls.target);
  }

  function pan(dx, dy) {
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const k = PAN * dist() / 10;
    move(right.multiplyScalar(-dx * k).addScaledVector(up, dy * k));
  }

  // ---- input ----------------------------------------------------------------
  const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (typing() || e.ctrlKey || e.metaKey || e.altKey || !FLY_KEYS.has(k)) return;
    keys.add(k);
  }
  function onKeyUp(e) { keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') keys.delete('shift'); }
  function onBlur() { keys.clear(); drag = null; }

  function onDown(e) {
    let mode = null;
    if (e.button === 2) mode = 'look';
    else if (e.button === 1) mode = 'pan';
    else if (e.button === 0 && canLook(e)) mode = 'look';
    if (!mode) return;
    if (e.button === 1) e.preventDefault();
    drag = { mode, x: e.clientX, y: e.clientY };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  }
  function onMove(e) {
    if (!drag) return;
    if (!canLook(e) && e.buttons === 1) { drag = null; return; } // the gizmo took this drag
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.mode === 'look') look(dx, dy); else pan(dx, dy);
  }
  function onUp() {
    drag = null;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
  }
  function onWheel(e) {
    e.preventDefault();
    const step = -e.deltaY * 0.02 * (keys.has('shift') ? 3 : 1);
    move(dirOf().normalize().multiplyScalar(THREE.MathUtils.clamp(step, -6, 6)));
  }
  const noMenu = (e) => e.preventDefault();

  // ---- on / off ---------------------------------------------------------------
  function enable() {
    if (active) return;
    active = true;
    saved = { r: controls.enableRotate, p: controls.enablePan, z: controls.enableZoom };
    controls.enableRotate = controls.enablePan = controls.enableZoom = false;
    // Start from the current view, with the target at a sensible distance ahead.
    aim(dirOf(), dist());
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', noMenu);
    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    addEventListener('blur', onBlur);
  }
  function disable() {
    if (!active) return;
    active = false;
    onUp();
    keys.clear();
    vel.set(0, 0, 0);
    Object.assign(controls, { enableRotate: saved.r, enablePan: saved.p, enableZoom: saved.z });
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('contextmenu', noMenu);
    removeEventListener('keydown', onKeyDown);
    removeEventListener('keyup', onKeyUp);
    removeEventListener('blur', onBlur);
  }

  // Per frame: fly with the held keys (eased, so starts and stops are soft).
  // With no keys held and at rest it leaves the camera alone, so a path
  // preview or anything else may move it.
  function update(dt) {
    if (!active) return;
    const want = new THREE.Vector3();
    if (keys.size) {
      const fwd = dirOf().normalize();
      const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize();
      if (keys.has('w')) want.add(fwd);
      if (keys.has('s')) want.sub(fwd);
      if (keys.has('d')) want.add(right);
      if (keys.has('a')) want.sub(right);
      if (keys.has('e')) want.y += 1;
      if (keys.has('q')) want.y -= 1;
      if (want.lengthSq()) want.normalize().multiplyScalar(SPEED * (keys.has('shift') ? 3 : 1));
    }
    vel.lerp(want, 1 - Math.exp(-dt * 10));
    if (vel.lengthSq() < 1e-4) { vel.set(0, 0, 0); return; }
    move(vel.clone().multiplyScalar(dt));
  }

  return {
    enable, disable, update,
    get active() { return active; },
    get dragging() { return !!drag; },
  };
}

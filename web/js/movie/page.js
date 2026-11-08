// The Movie page: scene text → agent run → set, cast, clips → per-character
// timeline → playback with a director camera → WebM export.
//
// The orchestrator and world agents run on the server (Nemotron, two calls,
// server/agents/movie.py) and stream their steps over SSE from
// /api/movie/plan; their script is cached per scene in library/scripts/. If
// planning fails with nothing cached, the page plays the mock (mock.js). The
// motion agent's Kimodo calls and the director's merge run here.
import * as THREE from 'three';
import { loadManifest } from '../library.js';
import { loadCharacter } from '../characters/index.js';
import { validateScript, plannedDuration } from './script.js';
import { FISHERMAN_SCENE, FISHERMAN_SCRIPT } from './mock.js';
import { API_BASE, urlParams } from '../api.js';
import { buildSet, setTimeOfDay } from './world.js';
import { motionFor, motionServerUp, MOTION_URL } from './clips.js';
import { direct, makeResolver } from './director.js';
import { createTimeline } from './timeline.js';
import { DirectorCamera } from './camera.js';
import { recordWebM } from './export.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const params = urlParams;
const FAST = params.has('fast'); // skip the log's typing delays (for tests)
const FRESH = params.has('fresh'); // ask Nemotron again instead of the cached plan

export function createMoviePage(root, stage, look) {
  const $ = (sel) => root.querySelector(sel);
  const ui = {
    prompt: $('#movie-prompt'),
    make: $('#movie-make'),
    log: $('#movie-log'),
    scriptView: $('#movie-script'),
    scriptBox: $('#movie-script-box'),
  };
  ui.prompt.value = params.get('scene') ?? FISHERMAN_SCENE;

  const state = {
    script: null,
    set: null,
    heroes: {}, // cast id → Character
    rows: {}, // cast id → director row
    t: 0,
    duration: 0,
    playing: false,
    busy: false,
    directorCam: true,
    exporting: false,
  };
  const cam = new DirectorCamera(stage, look);
  const timeline = createTimeline($('#movie-timeline'), {
    onPlay: () => setPlaying(!state.playing),
    onSeek: (t) => { setPlaying(false); seek(t); },
    onDirectorCam: (on) => { state.directorCam = on; cam.setEnabled(on); },
    onExport: () => exportMovie(),
  });

  // ---- agent log ----------------------------------------------------------
  function log(agent, kind, text, { err = false } = {}) {
    const li = document.createElement('li');
    li.className = `step ${kind}${err ? ' err' : ''}`;
    li.innerHTML = `<span class="agent ${agent}">${agent}</span><span class="kind">${kind}</span><span class="text"></span>`;
    li.querySelector('.text').textContent = text;
    ui.log.appendChild(li);
    ui.log.scrollTop = ui.log.scrollHeight;
    return li;
  }
  async function stream(step) {
    const li = log(step.agent, step.kind, '');
    if (step.ms >= 500) li.querySelector('.kind').textContent = `${step.kind} · ${(step.ms / 1000).toFixed(1)} s`;
    const span = li.querySelector('.text');
    if (FAST) { span.textContent = step.text; return; }
    // Type it out, as if tokens were arriving.
    for (let i = 0; i <= step.text.length; i += 3) {
      span.textContent = step.text.slice(0, i);
      ui.log.scrollTop = ui.log.scrollHeight;
      await sleep(12);
    }
    span.textContent = step.text;
    await sleep(80);
  }

  // The orchestrator + world run on the server, streamed. Steps are typed out
  // in order as they arrive; resolves with {script, source, llm_calls}.
  function planOnServer(scene) {
    return new Promise((resolve, reject) => {
      const url = `${API_BASE}/api/movie/plan?scene=${encodeURIComponent(scene)}${FRESH ? '&fresh=1' : ''}`;
      const es = new EventSource(url);
      let typing = Promise.resolve();
      let result = null;
      es.onmessage = (e) => { const step = JSON.parse(e.data); typing = typing.then(() => stream(step)); };
      es.addEventListener('script', (e) => { result = JSON.parse(e.data); });
      es.addEventListener('done', () => { es.close(); typing.then(() => resolve(result)); });
      es.onerror = () => {
        es.close();
        typing.then(() => (result ? resolve(result) : reject(new Error('the planning stream closed early'))));
      };
    });
  }

  // ---- building -----------------------------------------------------------
  function clear() {
    setPlaying(false);
    if (state.set) stage.scene.remove(state.set);
    for (const h of Object.values(state.heroes)) stage.scene.remove(h.group);
    Object.assign(state, { script: null, set: null, heroes: {}, rows: {}, t: 0, duration: 0 });
    ui.log.innerHTML = '';
    ui.scriptBox.hidden = true;
    timeline.reset();
  }

  async function make() {
    if (state.busy) return;
    state.busy = true;
    ui.make.disabled = true;
    try {
      clear();
      const text = ui.prompt.value.trim() || FISHERMAN_SCENE;
      const t0Plan = performance.now();
      let planned;
      try {
        planned = await planOnServer(text);
      } catch (err) {
        log('orchestrator', 'error', `${err.message}; playing the mock fisherman scene.`, { err: true });
        planned = { script: null, source: 'mock' };
      }
      const manifest = await loadManifest();
      // The orchestrator's output, checked against the contract.
      const script = planned.script ?? structuredClone(FISHERMAN_SCRIPT);
      if (!planned.script) log('orchestrator', 'note', 'mock script: the fisherman scene (mock.js)');
      state.source = planned.source;
      state.planSeconds = (performance.now() - t0Plan) / 1000;
      const problems = validateScript(script, manifest);
      if (problems.length) {
        problems.forEach((p) => log('orchestrator', 'error', p, { err: true }));
        throw new Error('the scene script is invalid');
      }
      state.script = script;
      log('orchestrator', 'script', `“${script.title}” · ${script.cast.length} cast · ${script.beats.length} beats · ${script.shots.length} shots · ${plannedDuration(script).toFixed(1)} s · from ${planned.source}${planned.llm_calls ? ` (${planned.llm_calls} Nemotron calls)` : ''}`);
      ui.scriptView.textContent = JSON.stringify(script, null, 2);
      ui.scriptBox.hidden = false;
      timeline.setScript(script);
      cam.setScript(script, makeResolver(script));

      // Characters load while the world agent works.
      const heroesReady = Promise.all(script.cast.map(async (c) => {
        const hero = await loadCharacter(c.character);
        hero.group.scale.setScalar(c.scale ?? 1);
        hero.group.visible = false;
        hero.playing = false;
        hero.group.name = c.id;
        state.heroes[c.id] = hero;
        stage.scene.add(hero.group);
        return hero;
      }));

      state.set = await buildSet(stage, script, async (line, err, kind = 'call') => {
        log('world', err ? 'error' : kind, line, { err });
        if (!FAST) await sleep(60);
      });
      log('world', 'result', `set built · ${state.set.children.length} items`);
      await heroesReady;
      log('world', 'result', `cast on set: ${script.cast.map((c) => `${c.name} (${c.character})`).join(', ')}`);

      // Motion agent: one Kimodo clip per beat.
      const up = await motionServerUp();
      log('motion', 'thought', up
        ? `Kimodo is up at ${MOTION_URL}. ${script.beats.length} clips, post_processing on, cached per prompt in the browser.`
        : `Kimodo isn't reachable at ${MOTION_URL}; falling back to library/motions (start gpu/tunnel.sh for real clips).`);
      const clipsByCast = Object.fromEntries(script.cast.map((c) => [c.id, new Map()]));
      for (const beat of script.beats) {
        const li = log('motion', 'call', `generate_motion(${beat.cast}, "${beat.prompt}", ${beat.duration}s)`);
        li.classList.add('pending');
        timeline.setBeatState(beat.id, 'pending');
        const m = await motionFor(beat);
        li.classList.remove('pending');
        const hero = state.heroes[beat.cast];
        const clip = hero.makeClip(m.text, beat.id);
        clipsByCast[beat.cast].set(beat.id, clip);
        log('motion', 'result', `${beat.id}: ${clip.duration.toFixed(1)} s from ${m.source}${m.file ? ` (${m.file})` : ''} · ${(m.ms / 1000).toFixed(1)} s`, { err: m.source === 'library' });
        timeline.setBeatState(beat.id, m.source === 'library' ? 'fallback' : 'ready');
      }

      // Director: line the beats up and merge each character's clips.
      log('director', 'thought', 'Joining each character\'s clips: match root and heading, turn at the join for `facing`, stretch walks to land on `to`, pin planted feet.');
      const t0 = performance.now();
      state.rows = direct(script, clipsByCast);
      for (const [id, row] of Object.entries(state.rows)) {
        const hero = state.heroes[id];
        hero.clips = row.beats.map((b) => clipsByCast[id].get(b.beat.id));
        hero.clip = row.clip;
        hero.seek(0);
        const stretched = row.beats.filter((b) => Math.abs(b.stretch - 1) > 0.02).map((b) => `${b.beat.id} ×${b.stretch.toFixed(2)}`);
        log('director', 'call', `add_to_timeline(${id}, ${row.beats.length} clips) → ${row.offset.toFixed(1)}–${row.end.toFixed(1)} s${stretched.length ? ` · stretched ${stretched.join(', ')}` : ''}`);
      }
      state.duration = Math.max(plannedDuration(script), ...Object.values(state.rows).map((r) => r.end));
      // Camera: cut the film into shots from the merged beats.
      const shots = cam.planShots(state.rows, state.duration, state.set);
      log('director', 'thought', `Cutting ${state.duration.toFixed(1)} s into shots: establish wide, then one shot per new action; every cut changes the size or the angle by 35°+, the camera stays on one side of the line between the characters, and swings around props that block the view.`);
      for (const s of shots) log('director', 'call', `shot(${s.id}, ${s.start.toFixed(1)}–${(s.start + s.duration).toFixed(1)} s, ${s.type} ${s.move} on ${[].concat(s.subject).join(' + ')}${s.partner ? ` over ${s.partner}'s shoulder` : ''}, from ${s.angle}°) · ${s.action}`);
      script.shots = shots;
      ui.scriptView.textContent = JSON.stringify(script, null, 2);
      timeline.setRows(state.rows, state.duration);
      log('director', 'result', `film ready · ${state.duration.toFixed(1)} s · merged in ${(performance.now() - t0).toFixed(0)} ms`);
      seek(0);
      if (!params.has('t')) setPlaying(true);
      else seek(+params.get('t'));
    } catch (err) {
      console.error(err);
      log('director', 'error', err.message, { err: true });
    } finally {
      state.busy = false;
      ui.make.disabled = false;
    }
  }
  ui.make.onclick = make;

  // ---- playback -----------------------------------------------------------
  function setPlaying(on) {
    if (on && state.t >= state.duration - 1e-3) seek(0);
    state.playing = on && state.duration > 0;
    timeline.setPlaying(state.playing);
  }
  function pose(t, dt) {
    for (const [id, row] of Object.entries(state.rows)) {
      const hero = state.heroes[id];
      hero.group.visible = t >= row.offset - 1e-3;
      hero.time = THREE.MathUtils.clamp(t - row.offset, 0, hero.duration);
      hero.apply();
      hero.vrm.update(dt);
    }
  }
  function seek(t) {
    state.t = THREE.MathUtils.clamp(t, 0, state.duration);
    pose(state.t, 0);
    cam.update(state.t, state.rows, 0, true);
    timeline.setTime(state.t);
  }

  function frame(dt) {
    if (state.playing) {
      state.t = Math.min(state.t + dt, state.duration);
      if (state.t >= state.duration) setPlaying(false);
    }
    if (Object.keys(state.rows).length) {
      pose(state.t, state.playing ? dt : 0);
      cam.update(state.t, state.rows, dt);
      timeline.setTime(state.t);
    }
    if (!state.directorCam || !Object.keys(state.rows).length) stage.controls.update();
  }

  function setVisible(on) {
    if (state.set) state.set.visible = on;
    for (const [id, h] of Object.entries(state.heroes)) h.group.visible = on && state.t >= (state.rows[id]?.offset ?? Infinity);
  }

  // ---- export -------------------------------------------------------------
  async function exportMovie() {
    if (!state.duration || state.exporting) return;
    state.exporting = true;
    timeline.setExporting(true);
    const wasCam = state.directorCam;
    state.directorCam = true;
    cam.setEnabled(true);
    try {
      seek(0);
      const result = await recordWebM(stage.renderer.domElement, {
        start: () => setPlaying(true),
        done: () => !state.playing && state.t >= state.duration - 1e-3,
        progress: () => state.t / state.duration,
        onProgress: (p) => timeline.setExportProgress(p),
      });
      state.lastExport = result;
      timeline.showExport(result);
      log('director', 'result', `exported ${result.name} · ${(result.blob.size / 1e6).toFixed(1)} MB · ${result.seconds.toFixed(1)} s`);
    } catch (err) {
      console.error(err);
      log('director', 'error', `export failed: ${err.message}`, { err: true });
    } finally {
      state.exporting = false;
      state.directorCam = wasCam;
      cam.setEnabled(wasCam);
      timeline.setExporting(false);
    }
  }

  return {
    frame,
    make,
    state,
    seek: (t) => { setPlaying(false); seek(t); },
    play: () => setPlaying(true),
    exportMovie,
    show() {
      setVisible(true);
      if (state.script) setTimeOfDay(stage, state.script.terrain?.time_of_day, state.script.terrain?.weather);
      cam.setEnabled(state.directorCam);
      if (params.has('autoplay') && !state.script && !state.busy) make();
    },
    hide() { setPlaying(false); cam.setEnabled(false); setVisible(false); },
  };
}

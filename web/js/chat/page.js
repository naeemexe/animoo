// The Chat page (task 10): one character in a little storybook set, and a
// chat panel. Mira opens with a greeting in her own words, and every reply
// comes from POST /api/chat (Nemotron; a rule-based mock only when the LLM is
// down, and then the bubble says so). Replies are spoken with speechSynthesis while the character plays a
// talking motion. A reply with `demonstrate` asks Kimodo for that motion
// (through gpu/tunnel.sh → localhost:8101, cached in the browser, library
// fallback), performs it, and merges back into idle.
//
// URL flags: #chat?say=show+me+a+squat sends a message on load (for tests).
import * as THREE from 'three';
import { LOOK } from '../look.js';
import { LIBRARY_BASE } from '../library.js';
import { loadCharacter } from '../characters/index.js';
import { buildSet, setTimeOfDay } from '../movie/world.js';
import { motionFor, motionServerUp, MOTION_URL } from '../movie/clips.js';
import { CHAT_SET } from './set.js';
import { createVoice } from './voice.js';
import { Performer } from './performer.js';

const CHARACTER = 'avatar_female';
const NAME = 'Mira';
const RAD = Math.PI / 180;
const params = new URLSearchParams(location.search);

// Camera: a medium-close shot from the front, a little to the right, so the
// character stands left of the chat panel.
const CAM = { yaw: 18 * RAD, dist: 6.0, height: 2.0, look: 1.0, band: 0.3 };

async function fetchText(path) {
  const res = await fetch(LIBRARY_BASE + path);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.text();
}

export function createChatPage(root, stage, look) {
  const $ = (sel) => root.querySelector(sel);
  const ui = {
    log: $('#chat-log'),
    form: $('#chat-form'),
    input: $('#chat-input'),
    send: $('#chat-send'),
    status: $('#chat-status'),
    voice: $('#chat-voice'),
    brain: $('#chat-brain'),
  };

  const state = {
    ready: null, // promise: set + character loaded
    set: null,
    hero: null,
    performer: null,
    messages: [], // what /api/chat sees
    busy: false,
    visible: false,
    saved: null, // the camera/controls as the Movie page left them
    camTarget: new THREE.Vector3(0, CAM.look, 0),
    mouth: 0,
    blink: { t: 2.5, v: 0 },
    clips: {},
  };

  const voice = createVoice({
    onVoices: ({ voices, voice: v }) => {
      ui.voice.innerHTML = '';
      if (!voices.length) {
        ui.voice.innerHTML = '<option>no voices installed</option>';
        ui.voice.disabled = true;
        return;
      }
      ui.voice.disabled = false;
      for (const x of voices.slice(0, 30)) {
        const o = document.createElement('option');
        o.value = o.textContent = x.name;
        if (x === v) o.selected = true;
        ui.voice.appendChild(o);
      }
    },
  });
  if (!voice.available) ui.voice.innerHTML = '<option>speech not supported</option>';
  ui.voice.onchange = () => voice.setVoice(ui.voice.value);

  function setStatus(text, kind = '') {
    ui.status.textContent = text;
    ui.status.className = `pill ${kind}`;
  }

  // ---- the log --------------------------------------------------------------
  function bubble(who, text) {
    const li = document.createElement('li');
    li.className = `msg ${who}`;
    li.innerHTML = `<span class="who"></span><span class="text"></span>`;
    li.querySelector('.who').textContent = who === 'user' ? 'You' : NAME;
    li.querySelector('.text').textContent = text;
    ui.log.appendChild(li);
    ui.log.scrollTop = ui.log.scrollHeight;
    return li;
  }
  function note(li, text, kind = '') {
    let n = li.querySelector('.note:not(.offline)');
    if (!n) { n = document.createElement('span'); li.appendChild(n); }
    n.className = `note ${kind}`;
    n.textContent = text;
    ui.log.scrollTop = ui.log.scrollHeight;
    return n;
  }

  // ---- loading --------------------------------------------------------------
  function load() {
    state.ready ??= (async () => {
      setStatus('building the set…');
      const [set, hero, idle, talk, wave] = await Promise.all([
        buildSet(stage, CHAT_SET),
        loadCharacter(CHARACTER),
        fetchText('motions/persona_idle.bvh'),
        fetchText('motions/talking.bvh'),
        fetchText('motions/persona_wave.bvh'),
      ]);
      state.set = set;
      state.hero = hero;
      hero.group.name = NAME;
      stage.scene.add(hero.group);
      state.clips = {
        idle: hero.makeClip(idle, 'idle'),
        talk: hero.makeClip(talk, 'talking'),
        wave: hero.makeClip(wave, 'wave'),
      };
      state.performer = new Performer(hero, state.clips);
      setVisible(state.visible);
      // Arrival: a wave, then idle.
      state.performer.perform(state.clips.wave);
      setStatus(NAME, 'ok');
      motionServerUp().then((up) => {
        if (!up) setStatus(`${NAME} · Kimodo offline, using library moves`, 'warn');
      });
    })().catch((err) => {
      console.error(err);
      setStatus(`failed to load: ${err.message}`, 'bad');
    });
    return state.ready;
  }

  // ---- a turn ---------------------------------------------------------------
  // send(text) is the user's turn; greet() asks for Mira's opening line (an
  // empty history), which Nemotron writes in her own words.
  const send = (text) => turn(text.trim());
  const greet = () => (state.messages.length ? Promise.resolve() : turn(null));

  async function turn(text) {
    if (text === '' || state.busy) return;
    state.busy = true;
    ui.send.disabled = true;
    if (text) ui.input.value = '';
    voice.stop();
    try {
      await load();
      if (text) {
        bubble('user', text);
        state.messages.push({ role: 'user', content: text });
      }
      const li = bubble(NAME, '');
      li.classList.add('thinking');
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: state.messages }),
      });
      if (!res.ok) throw new Error(`/api/chat returned ${res.status}`);
      const { reply, demonstrate, source, error } = await res.json();
      li.classList.remove('thinking');
      li.querySelector('.text').textContent = reply;
      state.messages.push({ role: 'assistant', content: reply });
      if (source === 'nemotron') {
        ui.brain.textContent = 'brain: Nemotron';
        ui.brain.className = '';
      } else {
        // Never quietly: the bubble, the footer and the console all say it.
        li.classList.add('mock');
        const tag = document.createElement('span');
        tag.className = 'note err offline';
        tag.textContent = 'Nemotron offline: mock reply';
        li.appendChild(tag);
        ui.brain.textContent = 'brain: mock (Nemotron offline)';
        ui.brain.className = 'bad';
        console.warn(`Chat: Nemotron offline, mock reply (${error || 'no reason given'})`);
      }

      // Ask Kimodo right away, while the first sentence is spoken.
      const clipReady = demonstrate ? fetchDemo(li, demonstrate) : null;
      let firstSentence;
      const firstDone = new Promise((r) => { firstSentence = r; });
      state.performer.setTalking(true);
      const spoken = voice.speak(reply, { onSentence: (i) => { if (i === 0) firstSentence(); } })
        .finally(() => { firstSentence(); state.performer.setTalking(false); });

      if (clipReady) {
        const [clip] = await Promise.all([clipReady, firstDone]);
        if (clip) await perform(li, clip);
      }
      await spoken;
    } catch (err) {
      console.error(err);
      bubble(NAME, `Sorry, something went wrong: ${err.message}`).classList.add('err');
    } finally {
      state.busy = false;
      ui.send.disabled = false;
      if (state.visible) ui.input.focus();
    }
  }

  async function fetchDemo(li, { prompt, duration }) {
    const n = note(li, `generating “${prompt}” (${duration} s) with Kimodo…`, 'pending');
    setStatus('generating a move…', 'warn');
    try {
      const m = await motionFor({ prompt, duration });
      const clip = state.hero.makeClip(m.text, prompt);
      n.className = `note${m.source === 'library' ? ' err' : ''}`;
      n.textContent = `${clip.duration.toFixed(1)} s clip from ${m.source}${m.file ? ` (${m.file})` : ''} · ${(m.ms / 1000).toFixed(1)} s`;
      if (m.source === 'library') console.warn(`Kimodo unreachable at ${MOTION_URL}; used ${m.file}`);
      return clip;
    } catch (err) {
      console.error(err);
      n.className = 'note err';
      n.textContent = `couldn't get the move: ${err.message}`;
      return null;
    } finally {
      setStatus(NAME, 'ok');
    }
  }

  async function perform(li, clip) {
    setStatus(`performing · ${clip.duration.toFixed(1)} s`, 'ok');
    li.classList.add('performing');
    await state.performer.perform(clip);
    li.classList.remove('performing');
    setStatus(NAME, 'ok');
    if (!li.querySelector('.again')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'again';
      b.textContent = '▶ again';
      b.onclick = () => { if (!state.performer.busy) perform(li, clip); };
      li.appendChild(b);
    }
  }

  ui.form.addEventListener('submit', (e) => { e.preventDefault(); send(ui.input.value); });

  // ---- per frame ------------------------------------------------------------
  function face(dt) {
    const em = state.hero.vrm.expressionManager;
    if (!em) return;
    // Mouth: a noisy open/close while the voice speaks.
    const t = performance.now() / 1000;
    const goal = voice.state.speaking ? 0.25 + 0.45 * Math.abs(Math.sin(t * 11) * Math.sin(t * 4.3 + 1)) : 0;
    state.mouth += (goal - state.mouth) * Math.min(1, dt * 18);
    em.setValue('aa', state.mouth);
    // Blink every few seconds.
    const b = state.blink;
    b.t -= dt;
    if (b.t < 0) { b.v = 1; b.t = 2 + Math.random() * 3.5; }
    b.v = Math.max(0, b.v - dt * 7);
    em.setValue('blink', b.v > 0.5 ? (1 - b.v) * 2 : b.v * 2);
  }

  function camera(dt, snap = false) {
    const cam = stage.camera;
    let x = 0, z = 0;
    if (state.performer) [x, , z] = state.performer.root();
    const goal = new THREE.Vector3(x, CAM.look, z);
    state.camTarget.lerp(goal, snap ? 1 : 1 - Math.exp(-dt * 1.5));
    const t = state.camTarget;
    // Slide the view sideways so the character stands in the middle of the
    // space the chat panel leaves free.
    const panel = ui.log.parentElement.getBoundingClientRect();
    const W = window.innerWidth || 1;
    const freeRight = panel.width && panel.height < window.innerHeight * 0.6 ? W : Math.min(W, panel.left);
    const viewW = 2 * CAM.dist * Math.tan((cam.fov * RAD) / 2) * cam.aspect;
    const shift = (0.5 - freeRight / 2 / W) * viewW;
    const right = new THREE.Vector3(Math.cos(CAM.yaw), 0, -Math.sin(CAM.yaw));
    const aim = t.clone().addScaledVector(right, shift);
    cam.position.set(t.x + Math.sin(CAM.yaw) * CAM.dist, CAM.height, t.z + Math.cos(CAM.yaw) * CAM.dist)
      .addScaledVector(right, shift);
    cam.lookAt(aim);
  }

  function frame(dt) {
    if (state.performer) {
      state.performer.update(dt);
      face(dt);
    }
    camera(dt);
  }

  function setVisible(on) {
    if (state.set) state.set.visible = on;
    if (state.hero) state.hero.group.visible = on;
  }

  return {
    state,
    send,
    voice,
    frame,
    show() {
      state.visible = true;
      const c = stage.controls;
      state.saved = { pos: stage.camera.position.clone(), target: c.target.clone(), enabled: c.enabled };
      c.enabled = false;
      look.uniforms.tiltH.band.value = look.uniforms.tiltV.band.value = CAM.band;
      setTimeOfDay(stage, CHAT_SET.terrain.time_of_day);
      setVisible(true);
      camera(0, true);
      load().then(async () => {
        const fresh = !state.messages.length;
        await greet();
        const say = params.get('say');
        if (say && fresh) send(say);
      });
      setTimeout(() => ui.input.focus(), 0);
    },
    hide() {
      state.visible = false;
      voice.stop();
      state.performer?.setTalking(false);
      setVisible(false);
      look.uniforms.tiltH.band.value = look.uniforms.tiltV.band.value = LOOK.tiltBand;
      const s = state.saved;
      if (s) {
        stage.camera.position.copy(s.pos);
        stage.controls.target.copy(s.target);
        stage.controls.enabled = s.enabled;
        stage.camera.lookAt(s.target);
      }
    },
  };
}

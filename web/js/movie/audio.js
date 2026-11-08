// Scene audio (task 32): an ambience bed and a very soft music pad, chosen by the
// orchestrator (script.audio, server/audio.py). Procedural WebAudio by default:
// filtered noise for rain, wind, waves, traffic, murmur and fire, little synth
// chirps for birds and crickets, and a few slow pad chords in the scene's mood.
// When the server has ElevenLabs files for the script's prompts (cached in
// library/audio/), those play instead.
//
// It follows the timeline: sync(t, playing, duration) every frame fades in on
// play, out on pause, in over the film's first 1.5 s and out over its last 2 s.
// The mix also goes to stream() (a MediaStream) for the WebM export; mute only
// silences the speakers.
import { API_BASE } from '../api.js';

export const LAYERS = ['rain', 'wind', 'waves', 'birds', 'crickets', 'traffic', 'murmur', 'fire'];
const CHORD = 8; // s per pad chord
// Four chords per mood (MIDI notes), voiced low and close.
const MOODS = {
  calm: [[48, 55, 64, 71], [45, 52, 60, 67], [41, 48, 57, 64], [43, 50, 59, 64]],
  warm: [[41, 48, 57, 64], [40, 48, 55, 64], [38, 45, 53, 60], [46, 53, 57, 62]],
  tender: [[43, 50, 59, 66], [40, 47, 55, 62], [48, 55, 64, 71], [50, 57, 62, 66]],
  playful: [[48, 55, 64, 69], [41, 53, 57, 62], [38, 50, 57, 60], [43, 53, 57, 62]],
  hopeful: [[48, 55, 64, 67], [47, 55, 62, 67], [45, 52, 60, 67], [41, 48, 57, 60]],
  melancholy: [[45, 52, 60, 64], [41, 48, 57, 64], [48, 55, 64, 67], [40, 47, 55, 62]],
  mysterious: [[38, 50, 53, 57], [46, 53, 58, 62], [43, 50, 55, 58], [45, 52, 57, 62]],
  cozy: [[39, 46, 55, 62], [36, 43, 51, 58], [44, 51, 55, 60], [46, 53, 55, 62]],
};
const MUSIC_LEVEL = 0.5; // the pad under the ambience (about -33 dBFS RMS at volume 0.25)
// Each builder's raw loudness differs: these bring a level of 1 to about RMS 0.25
// (measured with levels(); birds and crickets are events, so their peaks are matched).
const NORM = { rain: 0.4, wind: 0.45, waves: 0.45, birds: 3, crickets: 1.5, traffic: 1.2, murmur: 0.2, fire: 1.1 };
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);

// For scripts without audio (the mock, an old server): the same idea as the server's rules, shorter.
export function audioFor(script) {
  if (script?.audio?.ambience) return script.audio;
  const { biome = 'forest', time_of_day: tod = 'golden', weather = 'clear' } = script?.terrain ?? {};
  const night = tod === 'night';
  const L = { sea: { waves: 0.8, wind: 0.25 }, city: { traffic: 0.6, murmur: 0.25 }, park: { birds: 0.5, traffic: 0.12 },
    room: { wind: 0.08 }, restaurant: { murmur: 0.6 } }[biome] ?? { birds: 0.55, wind: 0.2 };
  if (night && L.birds) { delete L.birds; L.crickets = 0.5; }
  if (weather === 'rain') { L.rain = 0.8; delete L.birds; }
  if (weather === 'windy') L.wind = 0.7;
  const mood = weather === 'rain' ? 'melancholy' : { sunrise: 'hopeful', day: 'calm', golden: 'warm', dusk: 'tender', night: 'mysterious' }[tod] ?? 'calm';
  return { ambience: { prompt: '', layers: L }, music: { prompt: '', mood }, volume: 0.25, source: 'page rules' };
}

export function createSceneAudio({ log = () => {} } = {}) {
  let ctx = null;
  let nodes = null; // the graph for the current script
  let muted = false;
  try { muted = localStorage.getItem('animo.muted') === '1'; } catch { /* private window */ }
  let playing = false;
  let suspendTimer = 0;
  let filmLevel = -1;
  let gen = 0; // bumps on every load, so a late file fetch for an old script is dropped
  let live = []; // the current scene's running sources, stopped on teardown

  function context() {
    if (ctx) return ctx;
    ctx = new AudioContext();
    const master = ctx.createGain(); // volume × the film's fade
    const play = ctx.createGain(); // play/pause fade
    const out = ctx.createGain(); // mute (speakers only)
    play.gain.value = 0;
    out.gain.value = muted ? 0 : 1;
    master.connect(play);
    play.connect(out);
    out.connect(ctx.destination);
    const rec = ctx.createMediaStreamDestination();
    play.connect(rec);
    const mix = ctx.createAnalyser(); mix.fftSize = 1024;
    play.connect(mix);
    Object.assign(ctx, { master, play, out, rec, mix });
    // Browsers start an AudioContext suspended until the user interacts.
    const wake = () => { if (playing) ctx.resume(); };
    addEventListener('pointerdown', wake);
    addEventListener('keydown', wake);
    return ctx;
  }

  // White and brown noise, 4 s, looped by every layer from a random offset.
  let white, brown;
  function buffers() {
    if (white) return;
    const n = ctx.sampleRate * 4;
    white = ctx.createBuffer(1, n, ctx.sampleRate);
    brown = ctx.createBuffer(1, n, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    // Fade the loop seam of the brown buffer (it drifts).
    for (let i = 0; i < 2000; i++) { const k = i / 2000; b[i] *= k; b[n - 1 - i] *= k; }
  }
  const noise = (buf, out) => {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(0, rand(0, 3.9));
    s.connect(out);
    live.push(s);
    return s;
  };
  const filter = (type, f, q = 0.7) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
  const gain = (g) => { const x = ctx.createGain(); x.gain.value = g; return x; };
  const lfo = (freq, depth, target, type = 'sine') => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = gain(depth); o.connect(g); g.connect(target); o.start(); live.push(o); return o;
  };
  const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };
  const pan = (p) => { const x = ctx.createStereoPanner(); x.pan.value = p; return x; };

  // Each builder wires into `out` and may return { tick(when) → seconds to the next event }.
  const BUILD = {
    rain(out) {
      noise(white, chain(filter('highpass', 900), filter('lowpass', 7000), gain(0.35), out));
      noise(brown, chain(filter('lowpass', 450), gain(0.35), out));
      // Single drops on leaves and roofs.
      return { tick(at) {
        const s = ctx.createBufferSource(); s.buffer = white;
        const g = gain(0); const f = filter('bandpass', rand(1800, 4500), 6);
        chain(s, f, g, pan(rand(-0.8, 0.8)), out);
        g.gain.setValueAtTime(rand(0.15, 0.4), at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
        s.start(at, rand(0, 3.5), 0.06);
        return rand(0.02, 0.12);
      } };
    },
    wind(out) {
      const bp = filter('bandpass', 500, 0.9);
      const amp = gain(0.9);
      noise(white, chain(bp, amp, out));
      lfo(0.06, 260, bp.frequency);
      lfo(0.11, 0.55, amp.gain);
    },
    waves(out) {
      const lp = filter('lowpass', 800);
      const swell = gain(0.6);
      noise(brown, chain(lp, swell, out));
      const foam = gain(0.08);
      noise(white, chain(filter('highpass', 2500), foam, out));
      lfo(0.085, 0.55, swell.gain);
      lfo(0.085, 0.07, foam.gain);
      lfo(0.085, 400, lp.frequency);
    },
    birds(out) {
      return { tick(at) {
        const p = pan(rand(-0.9, 0.9)); p.connect(out);
        const f0 = rand(2400, 4600), n = 2 + Math.floor(rand(0, 4)), len = rand(0.06, 0.14);
        for (let i = 0; i < n; i++) {
          const t = at + i * (len + rand(0.04, 0.1));
          const o = ctx.createOscillator(); const g = gain(0);
          o.frequency.setValueAtTime(f0 * rand(0.9, 1.1), t);
          o.frequency.exponentialRampToValueAtTime(f0 * rand(1.15, 1.5), t + len);
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.015); g.gain.exponentialRampToValueAtTime(0.001, t + len);
          chain(o, g, p); o.start(t); o.stop(t + len + 0.02);
        }
        return rand(0.6, 2.8);
      } };
    },
    crickets(out) {
      for (const [f, rate, p] of [[4600, 2.3, -0.5], [4200, 1.7, 0.6]]) {
        const o = ctx.createOscillator(); o.frequency.value = f;
        const trill = gain(0.5), burst = gain(0.5);
        chain(o, trill, burst, gain(0.18), pan(p), out); o.start(); live.push(o);
        lfo(30, 0.5, trill.gain, 'square');
        lfo(rate, 0.5, burst.gain, 'square');
      }
    },
    traffic(out) {
      noise(brown, chain(filter('lowpass', 220), gain(0.7), out));
      // A car passing: a band of noise swelling and sweeping across.
      return { tick(at) {
        const d = rand(2.5, 5); const s = ctx.createBufferSource(); s.buffer = brown; s.loop = true;
        const f = filter('bandpass', 300, 1.2), g = gain(0), p = pan(-1);
        chain(s, f, g, p, out);
        f.frequency.setValueAtTime(260, at); f.frequency.linearRampToValueAtTime(rand(600, 900), at + d / 2); f.frequency.linearRampToValueAtTime(240, at + d);
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(rand(0.5, 0.9), at + d / 2); g.gain.linearRampToValueAtTime(0, at + d);
        const dir = Math.random() < 0.5 ? 1 : -1; p.pan.setValueAtTime(-dir, at); p.pan.linearRampToValueAtTime(dir, at + d);
        s.start(at, rand(0, 3)); s.stop(at + d + 0.1);
        return rand(2, 7);
      } };
    },
    murmur(out) {
      // Voices: a few formant bands of noise, each wobbling at a syllable rate.
      for (const [f, r, p] of [[380, 3.1, -0.4], [900, 4.3, 0.3], [1700, 5.7, 0], [600, 2.6, 0.6]]) {
        const amp = gain(0.35);
        noise(white, chain(filter('bandpass', f, 3), amp, pan(p), out));
        lfo(r, 0.3, amp.gain);
      }
      return { tick(at) { // a fork on a plate, a glass
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = rand(2600, 3800);
        const g = gain(0); chain(o, g, pan(rand(-0.7, 0.7)), out);
        g.gain.setValueAtTime(0.05, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.35);
        o.start(at); o.stop(at + 0.4);
        return rand(1.5, 5);
      } };
    },
    fire(out) {
      const roar = gain(0.45);
      noise(brown, chain(filter('lowpass', 500), roar, out));
      lfo(0.4, 0.12, roar.gain);
      return { tick(at) {
        const s = ctx.createBufferSource(); s.buffer = white;
        const g = gain(0); chain(s, filter('highpass', 1600), g, out);
        g.gain.setValueAtTime(rand(0.2, 0.6), at); g.gain.exponentialRampToValueAtTime(0.001, at + rand(0.01, 0.04));
        s.start(at, rand(0, 3.5), 0.05);
        return Math.random() < 0.7 ? rand(0.03, 0.15) : rand(0.3, 1.2);
      } };
    },
  };

  // The pad: two slightly detuned voices per note through a soft low-pass.
  function chord(notes, at) {
    const g = gain(0);
    const lp = filter('lowpass', 1100, 0.5);
    chain(lp, g, nodes.music);
    const oscs = [];
    for (const m of notes) for (const [type, cents, lvl] of [['triangle', -4, 0.11], ['sine', 5, 0.09]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(m); o.detune.value = cents;
      const v = gain(lvl); chain(o, v, lp); o.start(at); oscs.push(o);
    }
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(1, at + 2.5);
    return { release(t) {
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 3);
      oscs.forEach((o) => o.stop(t + 3.1));
    } };
  }

  function teardown() {
    if (!nodes) return;
    nodes.chord?.release(ctx.currentTime);
    stopFiles();
    for (const s of live) { try { s.stop(); } catch { /* not started */ } }
    live = [];
    nodes.bus.disconnect();
    nodes = null;
  }

  // Decoded ElevenLabs files: one looping source per kind while playing.
  function startFiles(t) {
    for (const f of Object.values(nodes.files)) {
      if (f.src) continue;
      f.src = ctx.createBufferSource(); f.src.buffer = f.buffer; f.src.loop = true;
      f.src.connect(f.gain); f.src.start(0, t % f.buffer.duration);
    }
  }
  function stopFiles() {
    for (const f of Object.values(nodes?.files ?? {})) { f.src?.stop(); f.src = null; }
  }

  async function fetchFiles(audio, myGen) {
    let res;
    try {
      const r = await fetch(`${API_BASE}/api/movie/audio`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ambience: audio.ambience?.prompt || null, music: audio.music?.prompt || null }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      res = await r.json();
    } catch (err) {
      return { note: `ElevenLabs files unavailable (${err.message}): procedural sound` };
    }
    const got = [];
    for (const kind of ['ambience', 'music']) {
      if (!res[kind]?.url || myGen !== gen) continue;
      try {
        const data = await (await fetch(`${API_BASE}${res[kind].url}`)).arrayBuffer();
        const buffer = await ctx.decodeAudioData(data);
        if (myGen !== gen || !nodes) return {};
        const g = gain(0);
        g.connect(kind === 'music' ? nodes.musicBus : nodes.amb);
        g.gain.setTargetAtTime(1, ctx.currentTime, 0.8);
        nodes.files[kind] = { buffer, gain: g, src: null };
        // Cross-fade the procedural part out.
        (kind === 'music' ? nodes.padBus : nodes.procAmb).gain.setTargetAtTime(0, ctx.currentTime, 0.8);
        if (kind === 'music') nodes.padOff = true;
        if (playing) startFiles(nodes.t ?? 0);
        got.push(`${kind} ${res[kind].cached ? 'cached' : `generated in ${res[kind].seconds} s`}`);
      } catch (err) {
        console.warn('scene audio file', kind, err);
      }
    }
    const why = Object.values(res.errors ?? {})[0];
    return { note: got.length ? `ElevenLabs: ${got.join(', ')} (library/audio)` : `ElevenLabs off${why ? ` (${why})` : ''}: procedural sound` };
  }

  return {
    LAYERS,
    get muted() { return muted; },
    get ctx() { return ctx; },
    get nodes() { return nodes; },
    // Build the graph for a script (null clears it). Resolves with a line for the log.
    async load(script) {
      gen++;
      if (ctx) teardown();
      if (!script) return null;
      const audio = audioFor(script);
      context(); buffers();
      const bus = gain(1); bus.connect(ctx.master);
      const amb = gain(1), music = gain(MUSIC_LEVEL); amb.connect(bus); music.connect(bus);
      const procAmb = gain(1); procAmb.connect(amb);
      const padBus = gain(1); padBus.connect(music);
      nodes = { audio, bus, amb, music, procAmb, padBus, layers: {}, files: {}, chord: null, chordIdx: -1, padOff: false };
      nodes.music = padBus; // chords go through the pad bus (a music file goes to `music` itself)
      nodes.musicBus = music;
      for (const [name, level] of Object.entries(audio.ambience.layers ?? {})) {
        if (!BUILD[name] || !(level > 0)) continue;
        const g = gain(level * NORM[name]);
        const an = ctx.createAnalyser(); an.fftSize = 1024;
        g.connect(procAmb); g.connect(an);
        const sched = BUILD[name](g);
        nodes.layers[name] = { gain: g, analyser: an, level, sched, next: 0 };
      }
      filmLevel = -1;
      const names = Object.keys(nodes.layers);
      const mood = audio.music?.mood ?? 'calm';
      const line = `sound: ${names.length ? names.map((n) => `${n} ${nodes.layers[n].level}`).join(' + ') : 'near silence'} · ${MOODS[mood] ? `soft ${mood} pad` : 'no music'} · volume ${audio.volume} (${audio.source})`;
      const myGen = gen;
      const files = fetchFiles(audio, myGen).then((r) => (myGen === gen ? r.note : null));
      return { line, files };
    },
    sync(t, on, duration) {
      if (!ctx || !nodes) return;
      nodes.t = t;
      const now = ctx.currentTime;
      if (on !== playing) {
        playing = on;
        clearTimeout(suspendTimer);
        ctx.play.gain.cancelScheduledValues(now);
        ctx.play.gain.setValueAtTime(ctx.play.gain.value, now);
        if (on) {
          ctx.resume();
          ctx.play.gain.linearRampToValueAtTime(1, now + 0.6);
          startFiles(t);
          for (const l of Object.values(nodes.layers)) l.next = now + rand(0.1, 1);
        } else {
          ctx.play.gain.linearRampToValueAtTime(0, now + 0.35);
          nodes.chord?.release(now); nodes.chord = null; nodes.chordIdx = -1;
          suspendTimer = setTimeout(() => { if (!playing) { stopFiles(); ctx.suspend(); } }, 450);
        }
      }
      // The film fades in over its first 1.5 s and out over its last 2 s.
      const env = duration > 0 ? Math.max(0, Math.min(1, t / 1.5, (duration - t) / 2)) : 1;
      const want = (nodes.audio.volume ?? 0.25) * (0.15 + 0.85 * env);
      if (Math.abs(want - filmLevel) > 0.004) {
        filmLevel = want;
        ctx.master.gain.setTargetAtTime(want, now, 0.08);
      }
      if (!playing) return;
      for (const l of Object.values(nodes.layers)) {
        if (!l.sched) continue;
        let n = 0;
        while (l.next < now + 0.25 && n++ < 20) l.next = Math.max(l.next, now) + l.sched.tick(Math.max(l.next, now));
      }
      const chords = MOODS[nodes.audio.music?.mood];
      const idx = Math.floor(t / CHORD);
      if (chords && !nodes.padOff && idx !== nodes.chordIdx) {
        nodes.chord?.release(now);
        nodes.chord = chord(chords[idx % chords.length], now);
        nodes.chordIdx = idx;
      }
    },
    setMuted(on) {
      muted = on;
      try { localStorage.setItem('animo.muted', on ? '1' : '0'); } catch { /* ignore */ }
      if (ctx) ctx.out.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.05);
    },
    // The mix for MediaRecorder (export.js); not affected by mute.
    stream() { return ctx?.rec.stream ?? null; },
    // RMS per layer and of the whole mix (for checks from the console).
    levels() {
      if (!nodes) return {};
      const rms = (an) => { const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a); return Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length); };
      return { ...Object.fromEntries(Object.entries(nodes.layers).map(([k, l]) => [k, +rms(l.analyser).toFixed(4)])), mix: +rms(ctx.mix).toFixed(4) };
    },
  };
}

// The timeline panel: transport (play, time, director camera, export), a
// camera lane with the shots, and one lane per character with its beats.
// Click or drag on the lanes to scrub.
import { plannedDuration } from './script.js';

export function createTimeline(root, { onPlay, onSeek, onDirectorCam, onExport }) {
  root.innerHTML = `
    <div class="tl-transport">
      <button type="button" class="tl-play" disabled>Play</button>
      <span class="pill tl-time">0.0 / 0.0 s</span>
      <label><input type="checkbox" class="tl-cam" checked> director camera</label>
      <span class="tl-spacer"></span>
      <progress class="tl-progress" max="1" value="0" hidden></progress>
      <a class="tl-download pill ok" hidden></a>
      <button type="button" class="tl-export" disabled>Export WebM</button>
    </div>
    <div class="tl-body">
      <div class="tl-labels"><div class="tl-ruler-label"></div></div>
      <div class="tl-lanes"><div class="tl-ruler"></div><div class="tl-playhead"></div></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const el = {
    play: $('.tl-play'), time: $('.tl-time'), cam: $('.tl-cam'), exp: $('.tl-export'),
    progress: $('.tl-progress'), download: $('.tl-download'),
    labels: $('.tl-labels'), lanes: $('.tl-lanes'), ruler: $('.tl-ruler'), head: $('.tl-playhead'),
  };
  let duration = 1;
  let blocks = new Map(); // beat id → element
  let t = 0;

  el.play.onclick = onPlay;
  el.cam.onchange = () => onDirectorCam(el.cam.checked);
  el.exp.onclick = onExport;

  const pct = (x) => `${(100 * x) / duration}%`;
  function lane(label, cls = '') {
    const l = document.createElement('div');
    l.className = 'tl-label';
    l.textContent = label;
    el.labels.appendChild(l);
    const d = document.createElement('div');
    d.className = `tl-lane ${cls}`;
    el.lanes.insertBefore(d, el.head);
    return d;
  }
  function block(laneEl, start, end, text, cls, title) {
    const b = document.createElement('div');
    b.className = `tl-block ${cls}`;
    b.style.left = pct(start);
    b.style.width = `calc(${pct(end - start)} - 2px)`;
    b.textContent = text;
    b.title = title ?? text;
    laneEl.appendChild(b);
    return b;
  }
  function ruler() {
    el.ruler.innerHTML = '';
    const step = duration > 40 ? 10 : duration > 12 ? 5 : 1;
    for (let s = 0; s <= duration + 1e-6; s += step) {
      const tick = document.createElement('span');
      tick.style.left = pct(s);
      tick.textContent = `${s}s`;
      el.ruler.appendChild(tick);
    }
  }
  function clearLanes() {
    el.labels.querySelectorAll('.tl-label').forEach((n) => n.remove());
    el.lanes.querySelectorAll('.tl-lane').forEach((n) => n.remove());
    blocks = new Map();
  }
  function layout(script, rows) {
    const states = new Map([...blocks].map(([id, b]) => [id, b.dataset.state]));
    clearLanes();
    ruler();
    const shots = lane('camera', 'shots');
    for (const s of script.shots) {
      const subj = [].concat(s.subject).join(' + ');
      const type = s.type ?? s.framing;
      block(shots, s.start, s.start + s.duration, `${type}${s.move && s.move !== 'static' ? ` ${s.move}` : ''} · ${subj}`, 'shot', `${s.id}: ${type}${s.move ? ` (${s.move})` : ''} on ${subj}${s.partner ? ` over ${s.partner}'s shoulder` : ''}, from ${s.angle ?? 35}°`);
    }
    for (const c of script.cast) {
      const l = lane(c.name, 'cast');
      const placed = rows?.[c.id]?.beats ?? script.beats.filter((b) => b.cast === c.id).map((beat) => ({ beat, start: beat.start, end: beat.start + beat.duration }));
      for (const p of placed) {
        const st = states.get(p.beat.id) ?? 'planned';
        const b = block(l, p.start, p.end, p.beat.action ?? p.beat.prompt, st,
          `${p.beat.id} · ${p.start.toFixed(1)}–${p.end.toFixed(1)} s\n${p.beat.prompt}`);
        b.dataset.state = st;
        blocks.set(p.beat.id, b);
      }
    }
  }

  // Scrubbing.
  function seekFromEvent(e) {
    const r = el.lanes.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  }
  el.lanes.addEventListener('pointerdown', (e) => {
    if (el.play.disabled) return;
    el.lanes.setPointerCapture(e.pointerId);
    seekFromEvent(e);
    const move = (ev) => seekFromEvent(ev);
    const up = () => { el.lanes.removeEventListener('pointermove', move); el.lanes.removeEventListener('pointerup', up); };
    el.lanes.addEventListener('pointermove', move);
    el.lanes.addEventListener('pointerup', up);
  });

  return {
    reset() {
      clearLanes();
      el.ruler.innerHTML = '';
      el.play.disabled = el.exp.disabled = true;
      el.download.hidden = true;
      duration = 1;
      this.setTime(0);
    },
    setScript(script) {
      duration = plannedDuration(script);
      layout(script);
      this.script = script;
    },
    setBeatState(id, s) {
      const b = blocks.get(id);
      if (b) { b.dataset.state = s; b.className = `tl-block ${s}`; }
    },
    setRows(rows, d) {
      duration = d;
      layout(this.script, rows);
      el.play.disabled = el.exp.disabled = false;
    },
    setTime(x) {
      t = x;
      el.head.style.left = pct(t);
      el.time.textContent = `${t.toFixed(1)} / ${duration.toFixed(1)} s`;
    },
    setPlaying(on) { el.play.textContent = on ? 'Pause' : 'Play'; },
    setExporting(on) {
      el.exp.disabled = el.play.disabled = on;
      el.progress.hidden = !on;
      el.exp.textContent = on ? 'Recording…' : 'Export WebM';
    },
    setExportProgress(p) { el.progress.value = p; },
    showExport({ url, name, blob }) {
      el.download.href = url;
      el.download.download = name;
      el.download.textContent = `Save movie.webm · ${(blob.size / 1e6).toFixed(1)} MB`;
      el.download.hidden = false;
    },
  };
}

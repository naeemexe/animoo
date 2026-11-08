// Drives one character through idle, talking and demonstrations.
//
// Every change of motion is a task 05 merge (merge.js) from the pose the
// character is in right now: the next clip is lined up with the current root
// and crossfaded in over `blend` seconds, so there is never a pop. Idle and
// talking loop by merging the clip onto its own end; a one-shot (wave, a
// demonstration) returns to idle the same way when it finishes.
import { Clip } from '../characters/clip.js';
import { mergeClips } from '../characters/merge.js';

// `count` frames of `clip` from frame `from`, holding the last frame past the end.
function window(clip, from, count) {
  const out = Clip.like(clip, count);
  for (let g = 0; g < count; g++) out.copyFrame(g, clip, Math.min(from + g, clip.frames - 1));
  out.segments = [{ name: clip.name, start: 0, end: count }];
  return out;
}

export class Performer {
  constructor(hero, { idle, talk }) {
    this.hero = hero;
    this.clips = { idle, talk };
    this.kind = null; // 'idle' | 'talk' | 'once'
    this.talking = false;
    this.pending = null; // resolve() of the running one-shot
    this.heading = 0; // face +Z (the camera side) at every join
    hero.playing = true;
    this.cut(idle, 'idle');
  }

  // Crossfade from the current pose into `clip`, starting now.
  cut(clip, kind, blend = 0.35) {
    const hero = this.hero;
    let merged;
    if (!hero.clip) {
      merged = clip.clone();
    } else {
      const n = Math.max(2, Math.round(blend * clip.fps));
      const from = Math.min(Math.floor(hero.time * hero.clip.fps), hero.clip.frames - 1);
      merged = mergeClips(window(hero.clip, from, n + 1), clip, { blend, heading: this.heading });
    }
    hero.clips = [merged];
    hero.clip = merged;
    hero.seek(0);
    this.kind = kind;
    this.label = clip.name;
  }

  // Talking gesture on (while the voice speaks) or off.
  setTalking(on) {
    if (on === this.talking) return;
    this.talking = on;
    if (this.kind === 'once') return; // a demonstration wins; talk resumes after it
    this.cut(on ? this.clips.talk : this.clips.idle, on ? 'talk' : 'idle', on ? 0.35 : 0.5);
  }

  // Play a clip once, then go back to idle (or talking). Resolves when it ends.
  perform(clip, { blend = 0.4 } = {}) {
    this.pending?.();
    this.cut(clip, 'once', blend);
    return new Promise((resolve) => { this.pending = resolve; });
  }

  get busy() { return this.kind === 'once'; }

  update(dt) {
    const hero = this.hero;
    hero.update(dt);
    // Start the next clip `blend` before this one runs out, so the join
    // overlaps real motion instead of a held pose.
    const left = hero.duration - hero.time;
    if (left > 0.42) return;
    if (this.kind === 'once') {
      const done = this.pending;
      this.pending = null;
      this.cut(this.talking ? this.clips.talk : this.clips.idle, this.talking ? 'talk' : 'idle', 0.5);
      done?.();
    } else {
      const loop = this.talking ? this.clips.talk : this.clips.idle;
      this.cut(loop, this.talking ? 'talk' : 'idle', 0.4);
    }
  }

  // Where the character stands (x, z) and its hips height, for the camera.
  root() {
    const c = this.hero.clip;
    const f = Math.min(Math.floor(this.hero.time * c.fps), c.frames - 1);
    return [c.hips[f * 3], c.hips[f * 3 + 1], c.hips[f * 3 + 2]];
  }
}

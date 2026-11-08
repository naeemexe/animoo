// A VRM on the storybook stage playing a sequence of Kimodo clips, merged into
// one performance. Open /characters.html.
//   ?char=avatar_female        which library VRM
//   ?clips=walk_forward,persona_wave   library/motions/ files, played in order
//   ?live                      ask the Kimodo server (tunnel on :8101) instead,
//                              for "A person walks forward" then "A person waves hello"
//   ?t=3.2                     start paused at 3.2 s (for screenshots)
//   ?outfit=chef&build=heavy&hair=red   a skin (task 35) on the hero
//   ?lineup=avatar_male:suit:slim,avatar_female:dress:heavy:blonde
//                              more figures beside the hero (char:outfit:build:hair),
//                              playing the same clips 1.2 m apart
import * as THREE from 'three';
import { createStage } from './stage.js';
import { createLook } from './look.js';
import { loadCharacter, fetchBVH, generateMotion, applyLook } from './characters/index.js';

const params = new URLSearchParams(location.search);
const stage = createStage(document.getElementById('app'));
const look = createLook(stage.renderer, stage.scene, stage.camera);
// Focus on the figure, a little blur behind.
look.setFocus({ point: stage.controls.target, blur: 3 });
// Closer than the world view: a person is 1.7 m on an 18 m island. The
// stage's resize() frames the whole island, so re-apply after it.
const camOffset = new THREE.Vector3(5.5, 4.2, 9);
function closeUp() {
  stage.controls.minDistance = 5;
  stage.camera.position.copy(stage.controls.target).add(camOffset);
  stage.controls.update();
}
closeUp();
window.addEventListener('resize', () => {
  stage.resize();
  look.setSize(window.innerWidth, window.innerHeight);
  closeUp();
});

const status = document.getElementById('status');
const setStatus = (text, cls = '') => { status.textContent = text; status.className = `pill ${cls}`; };

const LIVE_PROMPTS = [['A person walks forward', 5], ['A person waves hello', 4]];
const FALLBACK = ['walk_forward', 'persona_wave'];

async function clipsFor(hero) {
  if (params.has('live')) {
    try {
      const bvhs = [];
      for (const [prompt, duration] of LIVE_PROMPTS) bvhs.push(await generateMotion(prompt, { duration }));
      return bvhs.map((b, i) => hero.makeClip(b, LIVE_PROMPTS[i][0]));
    } catch (err) {
      console.warn('Kimodo server unreachable, using library clips:', err.message);
    }
  }
  const names = params.get('clips')?.split(',') ?? FALLBACK;
  const bvhs = await Promise.all(names.map((n) => fetchBVH(`motions/${n}.bvh`)));
  return bvhs.map((b, i) => hero.makeClip(b, names[i]));
}

const skinOf = (outfit, build, hair) => (outfit || build || hair ? { outfit, build, hair: hair && HAIRS[hair] || hair } : null);
const HAIRS = { black: '#1d1a1c', brown: '#5a3a22', blonde: '#e0c070', auburn: '#8a3b1f', red: '#b0451f', gray: '#9a9a9a', white: '#e8e6e0' };
const hero = await loadCharacter(params.get('char') ?? 'avatar_male');
applyLook(hero, skinOf(params.get('outfit'), params.get('build'), params.get('hair')));
stage.scene.add(hero.group);
const clips = await clipsFor(hero);
const merged = hero.setClips(clips);
// Start the walk so the whole sequence stays on the island.
hero.group.position.set(-1, 0, -4);
const lineup = await Promise.all((params.get('lineup')?.split(',') ?? []).map(async (spec, i) => {
  const [id, outfit, build, hair] = spec.split(':');
  const h = await loadCharacter(id || 'avatar_male');
  applyLook(h, skinOf(outfit, build, hair));
  stage.scene.add(h.group);
  h.setClips(await clipsFor(h));
  h.group.position.set(-1 + 1.2 * (i + 1), 0, -4);
  return h;
}));
// A row of skins: look at it from the front.
if (lineup.length) { camOffset.set(0, 0.8, 4 + 1.9 * lineup.length); closeUp(); }
setStatus(`${clips.map((c) => c.name).join(' → ')} · ${merged.duration.toFixed(2)} s`, 'ok');

// Foot target markers: green when planted. Transparent so they draw after
// the VRM's (mostly transparent-pass) MToon materials.
const marks = new THREE.Group();
marks.visible = false;
const markGeo = new THREE.SphereGeometry(0.07, 12, 8);
const markOn = new THREE.MeshBasicMaterial({ color: '#3fae4a', depthTest: false, transparent: true });
const markOff = new THREE.MeshBasicMaterial({ color: '#d9573f', depthTest: false, transparent: true });
const footMarks = ['left', 'right'].map(() => new THREE.Mesh(markGeo, markOn));
footMarks.forEach((m) => { m.renderOrder = 10; marks.add(m); });
hero.group.add(marks);

const ui = {
  play: document.getElementById('play'),
  scrub: document.getElementById('scrub'),
  time: document.getElementById('time'),
  segment: document.getElementById('segment'),
  ik: document.getElementById('ik'),
  marks: document.getElementById('marks'),
};
ui.scrub.max = merged.duration;
const setPlaying = (on) => { hero.playing = on; ui.play.textContent = on ? 'Pause' : 'Play'; };
ui.play.onclick = () => {
  if (hero.time >= hero.duration) hero.seek(0);
  setPlaying(!hero.playing);
};
ui.scrub.oninput = () => { setPlaying(false); hero.seek(+ui.scrub.value); };
ui.ik.onchange = () => { hero.ik = ui.ik.checked; hero.seek(hero.time); };
ui.marks.onchange = () => { marks.visible = ui.marks.checked; };

if (params.has('t')) { setPlaying(false); hero.seek(+params.get('t')); }
if (params.has('marks')) { ui.marks.checked = marks.visible = true; }

const hipsWorld = new THREE.Vector3();
const clock = new THREE.Clock();
function frameInfo() {
  const f = Math.min(Math.round(hero.time * merged.fps), merged.frames - 1);
  const seg = merged.segments.find((s) => f >= s.start && f < s.end) ?? merged.segments.at(-1);
  const blending = merged.blends?.some((b) => f >= b.start && f < b.end);
  return { f, seg, blending };
}
stage.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  hero.update(hero.playing ? dt : 0);
  for (const h of lineup) { h.ik = hero.ik; h.time = Math.min(hero.time, h.duration); h.apply(); h.vrm.update(dt); }
  const { f, seg, blending } = frameInfo();
  ['left', 'right'].forEach((s, i) => {
    footMarks[i].position.fromArray(merged.feet[s], f * 3);
    footMarks[i].material = merged.contact[s][f] ? markOn : markOff;
  });
  ui.scrub.value = hero.time;
  ui.time.textContent = `${hero.time.toFixed(2)} s`;
  ui.segment.textContent = blending ? `blend → ${seg.name}` : seg.name;
  // Follow the character, gently.
  hero.vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(hipsWorld);
  hipsWorld.y = 0.9;
  if (lineup.length) hipsWorld.x = hero.group.position.x + 0.6 * lineup.length; // the middle of the row
  const k = hero.playing ? 0.06 : 1;
  const move = hipsWorld.sub(stage.controls.target).multiplyScalar(k);
  stage.controls.target.add(move);
  stage.camera.position.add(move);
  stage.controls.update();
  look.render();
});

window.animo = { stage, look, hero, lineup, merged, frameInfo, seek: (t) => { setPlaying(false); hero.seek(t); } };

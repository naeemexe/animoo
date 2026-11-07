// A VRM on the storybook stage playing a sequence of Kimodo clips, merged into
// one performance. Open /characters.html.
//   ?char=avatar_female        which library VRM
//   ?clips=walk_forward,persona_wave   library/motions/ files, played in order
//   ?live                      ask the Kimodo server (tunnel on :8101) instead,
//                              for "A person walks forward" then "A person waves hello"
//   ?t=3.2                     start paused at 3.2 s (for screenshots)
import * as THREE from 'three';
import { createStage } from './stage.js';
import { createLook } from './look.js';
import { loadCharacter, fetchBVH, generateMotion } from './characters/index.js';

const params = new URLSearchParams(location.search);
const stage = createStage(document.getElementById('app'));
const look = createLook(stage.renderer, stage.scene, stage.camera);
// Keep the whole figure inside the tilt-shift's sharp band.
look.uniforms.tiltH.band.value = look.uniforms.tiltV.band.value = 0.22;
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

const hero = await loadCharacter(params.get('char') ?? 'avatar_male');
stage.scene.add(hero.group);
const clips = await clipsFor(hero);
const merged = hero.setClips(clips);
// Start the walk so the whole sequence stays on the island.
hero.group.position.set(-1, 0, -4);
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
  const k = hero.playing ? 0.06 : 1;
  const move = hipsWorld.sub(stage.controls.target).multiplyScalar(k);
  stage.controls.target.add(move);
  stage.camera.position.add(move);
  stage.controls.update();
  look.render();
});

window.animo = { stage, look, hero, merged, frameInfo, seek: (t) => { setPlaying(false); hero.seek(t); } };

// A hand-written orchestrator run for the fisherman scene in PLAN.md, so the
// Movie page works before Nemotron is wired in (task 09b swaps this for the
// agents' SSE stream). `FISHERMAN_SCRIPT` is in the format of script.js.

export const FISHERMAN_SCENE =
  'At sunrise an old fisherman walks out of his hut, stretches, waves at a kid ' +
  'running past the well, and then they both sit on the dock.';

export const FISHERMAN_SCRIPT = {
  version: 1,
  title: 'Morning on the dock',
  scene: FISHERMAN_SCENE,
  terrain: {
    time_of_day: 'sunrise',
    water: [{ shape: 'pond', center: [7, 9.5], radius: 5.5 }],
    paths: [{ points: [[-7.1, -3.0], [-4, 0], [-1, 2.8], [2, 3.8]], width: 1.4 }],
  },
  props: [
    { key: 'hut', library: 'stilt-hut', position: [-9.5, -6.5], rotation: 45 },
    { key: 'well', library: 'fountain', position: [-3.5, 3.5] },
    { key: 'dock', library: 'dock', position: [6.5, 6.6], rotation: 0 },
    { key: 'bench', library: 'bench', position: [2, 4.3], rotation: 90 },
    { key: 'boat', library: 'rowboat', position: [10, 9.5], rotation: 70 },
    { key: 'barrel', library: 'barrel', position: [-7.2, -4.2] },
    { key: 'crates', library: 'crate', position: [4.2, 2.4], rotation: 20 },
    { key: 'paddle', library: 'paddle', position: [4.9, 2.7], rotation: 10 },
    { key: 'logs', library: 'log-stack', position: [-11.5, -2.5], rotation: 80 },
    { key: 'tree1', library: 'tree-oak', position: [-12, 3] },
    { key: 'tree2', library: 'pine-tall', position: [-4, -11] },
    { key: 'tree3', library: 'tree-round', position: [10, -6] },
    { key: 'tree4', library: 'pine-round', position: [-13, -9] },
    { key: 'bush1', library: 'bush-large', position: [-6, 6] },
    { key: 'bush2', library: 'bush', position: [1, -4] },
    { key: 'lily1', library: 'lily-pad', position: [9, 12] },
    { key: 'lily2', library: 'lily-pad', position: [4.5, 11.5] },
    { key: 'rocks', library: 'rock-large', position: [12.5, 4.5], rotation: 30 },
    { key: 'flowers', library: 'flower-yellow', position: [-1.5, 5.5] },
    { key: 'lantern', library: 'lantern-post', position: [0.4, 2.2] },
  ],
  cast: [
    { id: 'fisherman', name: 'Old fisherman', character: 'avatar_male', start: { position: [-7.1, -3.0], facing: 40 } },
    { id: 'kid', name: 'Kid', character: 'avatar_female', scale: 0.8, start: { position: [4.2, -2.9], facing: -50 } },
  ],
  beats: [
    { id: 'f1', cast: 'fisherman', start: 0, duration: 4, action: 'walks out of the hut', prompt: 'An old man walks forward slowly.', to: [-5.6, -1.6] },
    { id: 'f2', cast: 'fisherman', start: 4, duration: 4, action: 'stretches', prompt: 'A person stretches both arms above their head.' },
    { id: 'f3', cast: 'fisherman', start: 8, duration: 3, action: 'waves at the kid', prompt: 'A person waves hello with their right hand.', facing: 'kid' },
    { id: 'f4', cast: 'fisherman', start: 11, duration: 7, action: 'walks to the dock', prompt: 'A person walks forward.', to: [1.5, 4.15] },
    { id: 'f5', cast: 'fisherman', start: 18, duration: 5, action: 'sits on the bench', prompt: 'A person sits down on a bench and rests.', facing: 0 },

    { id: 'k1', cast: 'kid', start: 3, duration: 6, action: 'runs past the well', prompt: 'A child runs forward fast.', to: [-1.6, 2.2] },
    { id: 'k2', cast: 'kid', start: 9, duration: 3, action: 'waves back', prompt: 'A person waves back excitedly with both hands.', facing: 'fisherman' },
    { id: 'k3', cast: 'kid', start: 13, duration: 4, action: 'walks to the dock', prompt: 'A person walks forward.', to: [2.5, 4.15] },
    { id: 'k4', cast: 'kid', start: 18, duration: 5, action: 'sits on the bench', prompt: 'A person sits down on a bench and rests.', facing: 0 },
  ],
  shots: [
    { id: 's1', start: 0, duration: 5, framing: 'medium', subject: 'fisherman', angle: 35 },
    { id: 's2', start: 5, duration: 4, framing: 'wide', subject: ['fisherman', 'kid'], angle: 20 },
    { id: 's3', start: 9, duration: 3, framing: 'medium', subject: 'kid', angle: -150 },
    { id: 's4', start: 12, duration: 6, framing: 'wide', subject: ['fisherman', 'kid'], angle: 30 },
    { id: 's5', start: 18, duration: 5, framing: 'medium', subject: 'bench', angle: -25 },
  ],
};

// What the orchestrator and world agent "said" while planning, replayed with
// these delays (ms) as if streamed. Motion and director steps are logged live
// by the page, because they do real work (Kimodo calls, merging).
export const FISHERMAN_STEPS = [
  { agent: 'orchestrator', kind: 'thought', ms: 500, text: 'Two characters: an old fisherman and a kid. One location: a hut, a well, a pond with a dock. Sunrise.' },
  { agent: 'orchestrator', kind: 'thought', ms: 700, text: 'The fisherman has four actions (walk out, stretch, wave, walk + sit). The kid runs past, waves back, joins him. Kimodo is clean up to 10 s, so every action is its own beat.' },
  { agent: 'orchestrator', kind: 'call', ms: 400, text: 'split_into_beats(cast=2, max_beat=10s)' },
  { agent: 'orchestrator', kind: 'result', ms: 300, text: '9 beats · fisherman 5 · kid 4 · 23 s' },
  { agent: 'orchestrator', kind: 'thought', ms: 500, text: 'Sync points: the wave (8 s) lands while the kid passes the well; both sit at 18 s.' },
  { agent: 'orchestrator', kind: 'call', ms: 400, text: 'plan_shots(5)' },
  { agent: 'orchestrator', kind: 'result', ms: 300, text: 'medium → wide → medium on the kid → wide → medium on the bench' },
  { agent: 'orchestrator', kind: 'script', ms: 300, text: 'scene script ready' },

  { agent: 'world', kind: 'thought', ms: 500, text: 'Terrain first: a pond in the south-east corner, a path from the hut down to the water.' },
  { agent: 'world', kind: 'call', ms: 400, text: "set_terrain(time_of_day='sunrise', pond=(7, 9.5) r=5.5, path=4 points)" },
  { agent: 'world', kind: 'call', ms: 400, text: "search_library('fisherman hut')" },
  { agent: 'world', kind: 'result', ms: 250, text: 'stilt-hut (tags: hut, shelter, fisherman)' },
  { agent: 'world', kind: 'call', ms: 400, text: "search_library('well')" },
  { agent: 'world', kind: 'result', ms: 250, text: 'no match · closest: fountain (water, square)' },
  { agent: 'world', kind: 'thought', ms: 500, text: 'A fountain reads as a village well from above. Using it rather than generating a prop.' },
  { agent: 'world', kind: 'call', ms: 400, text: "search_library('dock')" },
  { agent: 'world', kind: 'result', ms: 250, text: 'dock, dock-small · taking dock (4 m) · bench for sitting' },
  { agent: 'world', kind: 'place', ms: 0, text: 'placing props' },
];

# Animo World

## Pitch

Animo World turns one sentence into a short 3D storybook film. You type "In a small
restaurant at night, a man sits at a table for two, a woman walks in and waves, sits down
across from him, and they talk and laugh", and a team of NVIDIA Nemotron agents writes the
script, builds the set, casts the characters and plans every beat. The motion comes from
NVIDIA's Kimodo text-to-motion model. A director then plans each walk around the props,
sits characters onto real chairs, and cuts the film into cinematic shots. Everything renders
in the browser as a toon-shaded, tilt-shifted diorama with time of day, weather and its own
scene sound. Then you can step into the set: fly a free camera around it, move, add or delete
props, draw the camera's and the characters' paths by hand, and the director re-plans the film
around your changes. Every plan, clip and generated prop is cached, so a finished film replays
instantly, with or without the GPU.

## Demo videos (in this folder)

All five were recorded once each with the app's own **Export WebM** button (1920×1080, VP9 video
with an Opus sound track, 56 MB in all), after round 3 (smoother trees, blended roads, collision
rules, scene sound). The sound is the procedural ambience and music pad the orchestrator planned
for each scene (no ElevenLabs key was set). The cached scenes were played back with the motion
and asset servers pointed at a dead port, so the GPU played no part in them.

| File | Scene prompt | Shows | Length |
|---|---|---|---|
| `01-park-bench.webm` | In a park on a sunny afternoon, a boy sits on the grass, slowly stands up, walks around the park bench to his friend and waves to her, and she waves back. | park biome, golden light, A* path around the bench, aimed waves; birds, breeze, warm pad | 21 s |
| `02-city-street.webm` | On a city street at noon, a man sits on a bench by the cafe, a woman walks around the fountain to him and waves, he stands up and waves back, and they talk. | city biome (streets with curbs, cafe, cars), sit / stand / talk, low and side shots; traffic and murmur | 24 s |
| `03-beach-harbor.webm` | On a sunny morning at the beach harbor, a fisherman carries a crate along the dock to his rowboat, a girl digs in the sand by the palm trees, then she waves to him and he waves back. | sea biome (sand, palms, water, dock, rowboat); waves, birds, wind | 11 s |
| `04-restaurant-night.webm` | In a small restaurant at night, a man sits at a table for two, a woman walks in and waves, sits down across from him, and they talk and laugh. | interior biome, eye-level camera, seating on chairs, night windows; restaurant murmur | 17 s |
| `05-night-rain-lamplighter.webm` | At night in the rain a lamplighter walks down the village street, lights a lantern by the houses, and waves to a girl at her window. | night + rain, glowing lamps, a live Kimodo clip ("lights a lantern") replayed from the cache; rain, wind, crickets | 21 s |

## How it works

```
prompt
  └─ Orchestrator agent (Nemotron) ── scene plan: cast and their looks, beats, biome, time of day,
                                       weather, scene audio (ambience layers + music mood + prompts)
       └─ World agent (Nemotron) ───── set: searches the prop library, places props,
                                       marks seats and targets; generates missing props
            ├─ Motion: each beat → a clip from the cached action library (28 Kimodo moves:
            │          walk, run, sit_bench, wave, talk, dig, …) or a live Kimodo clip
            │          for anything new, kept in library/motions/live/
            ├─ Director: joins each character's clips, plans walks with A* on a 0.25 m grid
            │          around the props, turns gestures toward their target, snaps sitters
            │          onto the nearest seat, pins planted feet; collision rules: characters
            │          are capsules and walk around each other, beats follow a moved prop,
            │          hand-drawn paths are pushed off props
            └─ Camera: cuts the film into shots (wide, medium, close, side, low,
                       over-the-shoulder; dolly, orbit, crane, pull), keeps the 180° line,
                       swings around props that block the view, eye level indoors
  └─ Renderer (three.js in the browser): VRM characters retargeted from Kimodo's BVH, leg IK,
     toon materials with outlines, procedural biomes (forest, city, sea, park, room,
     restaurant), sky, lighting for day / golden / dusk / night, rain / snow / fog,
     depth of field, smooth tree crowns, roads that blend into the ground, procedural scene
     sound (or ElevenLabs files when keyed) → Play or Export WebM (video + sound)
  └─ Edit mode: free spectator camera, move / rotate / scale / duplicate / delete / replace /
     regenerate props, numbered path editor for camera keys and character walks, save to the
     cache; leaving edit mode re-directs the film around the edited set
```

### New in round 3

- **Free spectator camera.** Fly around the set with WASD + mouse look (wheel dollies), on in edit
  mode or from the timeline's "free camera" toggle; turning it off gives the shot back to the director.
- **Edit mode.** An "edit set" checkbox pauses the film and lets you click any prop to move, rotate or
  scale it (keys 1/2/3), duplicate (Ctrl+D), delete (Del), replace it with any library prop, or
  regenerate it on the GPU. Save writes the edits into the scene's cache, so the replay keeps them.
- **Numbered path editor.** Camera paths (pink, with height handles and aim lines) and character walks
  (teal) are drawn as numbered nodes on a dotted curve. Drag a node, add or delete points; the camera
  scrubs to a key when you click it, and a walk passes through every node you draw.
- **Collision rules.** Characters keep 0.7 m apart and re-plan their walks around each other; when you
  move or turn a prop, the beats and start spots near it move with it; a drawn path that cuts through a
  prop is routed around it.
- **Smoother trees and blended roads.** Kit trees get soft rounded crowns; paths fade into the grass with
  soft edges, and city streets get curbs and sidewalk lamps.
- **Scene audio.** The orchestrator plans each scene's sound in the same Nemotron call: ambience layers
  (rain, wind, waves, birds, crickets, traffic, murmur, fire) and a soft music mood, each with a prompt.
  The page plays it procedurally in sync with play/pause/seek and mixes it into the WebM export; with an
  `ELEVENLABS_API_KEY` the prompts go to ElevenLabs Sound Effects and Music, cached in `library/audio/`
  with their prompts, and the page cross-fades to them.

### Nemotron agents and models

Nemotron is the only LLM in the product (`server/llm.py`). Each agent has its own model:

| Agent | Model (hosted on build.nvidia.com) |
|---|---|
| Orchestrator (scene plan) | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| Self-check | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| World (set building, tool calls) | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Motion, director | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Chat (Mira, the character you talk to) | `nvidia/nemotron-3.5-lightning-30b-a3b` |

A new movie takes **two Nemotron calls** (orchestrator, then world), about 5 s in all. If the
hosted API errors or rate-limits, the call falls back to a self-hosted **Nemotron Nano 9B v2**
(FP8, vLLM on the GPU box), then to OpenCode's free Nemotron tier, then to a clearly labeled mock.
The director's shot planning and path planning are rules, not LLM calls.

### What is cached and what is live

| Piece | Cached (works offline) | Live (needs network / GPU) |
|---|---|---|
| Scene plans | `library/scripts/*.json`: 13 scenes, keyed by the prompt, with the models that wrote them | a new prompt calls Nemotron (hosted) |
| Motion | `library/motions/actions/`: 28 Kimodo clips; `library/motions/live/`: 7 Kimodo clips generated for earlier scenes | a move not in either goes to Kimodo on the GPU; if the GPU is down it falls back to the action library |
| Props | 46 Kenney CC0 models, 13 procedural furniture pieces, 10 generated props in `library/props/generated/` (each with its prompt) | a prop missing from the library: SANA-Sprint image → TRELLIS.2 mesh on the GPU |
| Characters | 2 VRMs in `library/characters/` | — |
| Chat | — | Nemotron reply, spoken by the browser's speech synthesis |
| Scene sound | procedural (`web/js/movie/audio.js`), always works; ElevenLabs files in `library/audio/` once generated | ElevenLabs Sound Effects + Music (only with a key) |

The five demo films above use only the cached column.

## Models, assets and licenses

### Models

| Model | Used for | License / terms |
|---|---|---|
| NVIDIA Nemotron 3.5 Super VL 120B-A12B (`nvidia/nemotron-3.5-super-vl-120b-a12b`) | orchestrator, self-check | NVIDIA hosted API (build.nvidia.com); model under NVIDIA's open model license per its model card |
| NVIDIA Nemotron 3.5 Lightning 30B-A3B (`nvidia/nemotron-3.5-lightning-30b-a3b`) | world, motion, director, chat | as above |
| NVIDIA Nemotron Nano 9B v2 (FP8, self-hosted with vLLM) | fallback LLM | NVIDIA Open Model License |
| OpenCode Zen free Nemotron (`nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`) | last LLM fallback before the mock | OpenCode Zen terms |
| NVIDIA Kimodo (`Kimodo-SOMA-RP-v1.2`, github.com/nv-tlabs/kimodo) | text → motion (BVH) for every clip | per the nv-tlabs/kimodo repo and model card; its LLM2Vec text encoder is built on Meta Llama 3 (Llama 3 Community License) |
| Microsoft TRELLIS.2-4B (`microsoft/TRELLIS.2-4B`) | image → textured 3D mesh for generated props | MIT; it loads DINOv3 features (Meta DINOv3 license) |
| ElevenLabs Sound Effects (`eleven_text_to_sound_v2`) and Music (`music_v1`), optional | scene ambience and music bed when `ELEVENLABS_API_KEY` is set (not used in the demo takes) | ElevenLabs terms of service |
| BiRefNet (`ZhengPeng7/BiRefNet`) | background removal before TRELLIS.2 | MIT |
| NVIDIA SANA-Sprint 1.6B (`Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers`) | text → concept image for generated props | Apache-2.0; its text encoder Gemma-2-2B-IT is under the Gemma Terms of Use |

### Characters

| File | Credit | Terms |
|---|---|---|
| `library/characters/avatar_female.vrm` ("black hair Cat girl") | **SherryKatzu** (VRoid Hub) | credit required, commercial use allowed, **modification and redistribution not allowed** |
| `library/characters/avatar_male.vrm` ("Boy") | **SherryKatzu & Rarestgrass** (VRoid Hub) | credit required, commercial use allowed, **modification and redistribution not allowed** |

The VRM files are not redistributable. They are in this private repository only so the app
runs; they must not be published, and a public release needs its own characters (or the
authors' permission).

### 3D assets

| Source | Count | License |
|---|---|---|
| Kenney Nature Kit 2.1 (kenney.nl/assets/nature-kit) | 24 | CC0-1.0 |
| Kenney Pirate Kit 2.1 (kenney.nl/assets/pirate-kit) | 9 | CC0-1.0 |
| Kenney Fantasy Town Kit 2.0 (kenney.nl/assets/fantasy-town-kit) | 7 | CC0-1.0 |
| Kenney Starter Kit City Builder (github.com/KenneyNL/Starter-Kit-City-Builder) | 6 | CC0-1.0 (models) |
| Procedural furniture (`web/js/furniture.js`) and biome fill (`web/js/movie/fill.js`, `interior.js`) | 13 + scatter | this project's own code |
| Generated props (SANA-Sprint → TRELLIS.2), `library/props/generated/` | 10 | generated by the models above, under their terms |
| Five props from the earlier Animo project (`library/props/*.glb`) | 5 | origin not recorded (likely image → 3D); replace before a public release |
| Kimodo motion clips (`library/motions/`) | 28 actions + 7 live + 10 samples | generated with Kimodo (see above) |

### Code libraries

- three.js r160 (`three@0.160.0`), MIT
- @pixiv/three-vrm 2.1.3, MIT
- FastAPI, Uvicorn, python-dotenv (server), MIT / BSD
- vLLM (self-hosted Nemotron), Apache-2.0
- diffusers / transformers (SANA-Sprint), Apache-2.0

## Shot list for a 2–3 minute demo video

Fast and concise: short narration, one feature per beat. Record the screen for parts 1, 2, 4 and
6 (offline launch config, cached scenes, so nothing waits on the network). Parts 3 and 5 use the
WebM files in this folder, which carry their own scene sound; keep it under the narration. Times
are approximate.

| # | Time | Picture | Narration (suggested) |
|---|---|---|---|
| 1 | 0:00–0:15 | Title card, then the Chat page: Mira waves; ask "show me a squat" and cut to her doing it | "This is Animo World. Talk to a character and she acts it out: Nemotron answers, NVIDIA's Kimodo makes the move." |
| 2 | 0:15–0:40 | Screen recording on the Movie page: type the park-bench prompt, press Make. The agent log fills in: orchestrator plan (cast, looks, audio), world agent's `search_library` calls, motion clips, director's shots. | "Describe a scene and a team of Nemotron agents builds it in front of you. The orchestrator plans the beats, the cast, even the sound. The world agent builds the set with tool calls, Kimodo gives every beat its motion, and the director plans paths around the props and cuts it into shots." |
| 3 | 0:40–1:00 | `01-park-bench.webm` | "The boy walks around the bench to his friend, and the wave turns toward her." |
| 4 | 1:00–1:45 | Screen recording on the same scene: tick **edit set**. Fly the free camera low over the park (WASD + mouse). Click the bench, drag it 3 m and turn it; the friend's spot moves with it. Duplicate a tree with Ctrl+D, delete a bush. Open the character path: drag numbered nodes 1 and 3 into a curve, add a point. Show the pink camera path, raise a key with its ↕ handle. Untick edit set: the log says "re-directed around the edited set", and play: the boy walks the new curve around the moved bench. | "Then step inside. A free camera flies anywhere. Move the bench and the story moves with it. Plant a tree, delete a bush. Draw the boy's walk and the camera's path as numbered points. Leave edit mode and the director re-plans everything: no one walks through a bench or through each other." |
| 5 | 1:45–2:35 | `02-city-street.webm` (0:15), `04-restaurant-night.webm` (0:15), `03-beach-harbor.webm` (0:08), `05-night-rain-lamplighter.webm` (0:12), each with its prompt as a caption | "The same pipeline does a city street, a restaurant at night with an eye-level camera, a harbor, and rain after dark. The sound is planned too: traffic, a dining-room murmur, waves, rain and crickets. And the lamplighter's move wasn't in our library, so Kimodo generated it live, and now it's cached." |
| 6 | 2:35–2:55 | Closing card: Nemotron agents → Kimodo motion → TRELLIS.2 props → three.js film with sound. Credits: VRM characters by SherryKatzu and Rarestgrass, Kenney CC0 kits. | "Every plan, clip and prop is cached, so any film replays instantly, even with the GPU off. That's Animo World." |

For part 2, use a cached prompt (park bench or restaurant) so the log plays at reading speed;
add `?fresh` to the URL only to show a live Nemotron call. For part 4, avoid dropping the bench
onto a bush (props don't push each other), and don't save the edits, or restore the cache file
after, so the cached scene stays as recorded. Unmute with the **Sound on** button in the
transport if the browser has it off.

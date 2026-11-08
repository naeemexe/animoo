# Animo World

## Pitch

Animo World turns one sentence into a short 3D storybook film. You type "In a small
restaurant at night, a man sits at a table for two, a woman walks in and waves, sits down
across from him, and they talk and laugh", and a team of NVIDIA Nemotron agents writes the
script, builds the set, casts the characters and plans every beat. The motion comes from
NVIDIA's Kimodo text-to-motion model. A director then plans each walk around the props,
sits characters onto real chairs, and cuts the film into cinematic shots. Everything renders
in the browser as a toon-shaded, tilt-shifted diorama with time of day and weather. Every
plan, clip and generated prop is cached, so a finished film replays instantly, with or
without the GPU.

## Demo videos (in this folder)

All five were recorded once each with the app's own **Export WebM** button (1920×1080, VP9).
The cached scenes were played back with the motion and asset servers pointed at a dead port,
so the GPU played no part in them.

| File | Scene prompt | Shows | Length |
|---|---|---|---|
| `01-park-bench.webm` | In a park on a sunny afternoon, a boy sits on the grass, slowly stands up, walks around the park bench to his friend and waves to her, and she waves back. | park biome, golden light, A* path around the bench, aimed waves | 21 s |
| `02-city-street.webm` | On a city street at noon, a man sits on a bench by the cafe, a woman walks around the fountain to him and waves, he stands up and waves back, and they talk. | city biome (streets, cafe, cars), sit / stand / talk, low and side shots | 24 s |
| `03-beach-harbor.webm` | On a sunny morning at the beach harbor, a fisherman carries a crate along the dock to his rowboat, a girl digs in the sand by the palm trees, then she waves to him and he waves back. | sea biome (sand, palms, water, dock, rowboat) | 11 s |
| `04-restaurant-night.webm` | In a small restaurant at night, a man sits at a table for two, a woman walks in and waves, sits down across from him, and they talk and laugh. | interior biome, eye-level camera, seating on chairs, night windows | 17 s |
| `05-night-rain-lamplighter.webm` | At night in the rain a lamplighter walks down the village street, lights a lantern by the houses, and waves to a girl at her window. | night + rain, glowing lamps, a live Kimodo clip ("lights a lantern") replayed from the cache | 21 s |

## How it works

```
prompt
  └─ Orchestrator agent (Nemotron) ── scene plan: cast, beats, biome, time of day, weather
       └─ World agent (Nemotron) ───── set: searches the prop library, places props,
                                       marks seats and targets; generates missing props
            ├─ Motion: each beat → a clip from the cached action library (28 Kimodo moves:
            │          walk, run, sit_bench, wave, talk, dig, …) or a live Kimodo clip
            │          for anything new, kept in library/motions/live/
            ├─ Director: joins each character's clips, plans walks with A* on a 0.25 m grid
            │          around the props, turns gestures toward their target, snaps sitters
            │          onto the nearest seat, pins planted feet
            └─ Camera: cuts the film into shots (wide, medium, close, side, low,
                       over-the-shoulder; dolly, orbit, crane, pull), keeps the 180° line,
                       swings around props that block the view, eye level indoors
  └─ Renderer (three.js in the browser): VRM characters retargeted from Kimodo's BVH, leg IK,
     toon materials with outlines, procedural biomes (forest, city, sea, park, room,
     restaurant), sky, lighting for day / golden / dusk / night, rain / snow / fog,
     depth of field → Play or Export WebM
```

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

Record the screen for parts 1–2 and 5. Parts 3–4 are the WebM files in this folder. Times
are approximate.

| # | Time | Picture | Narration (suggested) |
|---|---|---|---|
| 1 | 0:00–0:15 | Title card, then the Movie page with an empty prompt box | "This is Animo World. You write one sentence, and a team of Nemotron agents makes it into a little 3D film." |
| 2 | 0:15–0:45 | Screen recording: type the restaurant prompt, press Make. The agent log fills in: orchestrator plan, world agent's `search_library` calls, motion clips, director's shots. | "The orchestrator, on Nemotron Super, splits the story into beats and picks the place, time and weather. The world agent, on Nemotron Lightning, builds the set from the library with tool calls. Each beat gets a motion clip from NVIDIA's Kimodo. Then the director plans the paths around the furniture, puts people onto real chairs, and cuts it into shots." |
| 3 | 0:45–1:05 | `04-restaurant-night.webm` | "Indoors the camera stays at eye level: two-shots, over the shoulder, never through a wall." |
| 4 | 1:05–2:20 | `01-park-bench.webm` (0:20), `02-city-street.webm` (0:20), `03-beach-harbor.webm` (0:10), `05-night-rain-lamplighter.webm` (0:20), each with its prompt as a caption | "The same pipeline handles a park, a city street, a harbor, and night with rain. Walks route around benches and fountains, waves turn toward the person they're for, and lamps light up after dark. The lamplighter's 'lights a lantern' move wasn't in our action library, so Kimodo generated it live, and now it's cached." |
| 5 | 2:20–2:40 | Screen recording: the Chat page, ask Mira a question and "show me a squat" | "You can also talk to a character. Mira answers with Nemotron and acts out moves with Kimodo." |
| 6 | 2:40–2:55 | Closing card: Nemotron agents → Kimodo motion → TRELLIS.2 props → three.js film. Credits: VRM characters by SherryKatzu and Rarestgrass, Kenney CC0 kits. | "Every plan, clip and prop is cached, so any film replays instantly, even with the GPU off. That's Animo World." |

For part 2, use a prompt that is already cached (the restaurant one) so the log plays at
reading speed without waiting on the network; add `?fresh` to the URL only if you want to
show a live Nemotron call.

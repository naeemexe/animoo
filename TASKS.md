# Tasks

**Deadline: Sunday 2026-11-08, 12:00 pm.** Lock what's working by **9:00 am**;
after that, only the demo task is in progress.

Each task gets **one Claude session**, which is closed once the task is reviewed
(see `WORKFLOW.md`). Sessions in different tracks touch different folders, so
**one session per track can run at the same time**:

- **A, app** (`web/`, `server/`, `library/`)
- **B, GPU** (`gpu/`, which runs on the RunPod pod)

Status: `todo` · `doing` · `waiting` · `done`

| # | Track | Task | Budget | Status | Needs first |
|---|---|---|---|---|---|
| 01 | A | Skeleton + storybook look | 2.5 h | done | — |
| 02 | B | Kimodo motion server on the pod (:8101) | 1.5 h | done | — |
| 03 | B | TRELLIS.2 asset server on the pod (:8102) | 2 h | done | — |
| 04 | A | Library: the old project's VRMs, props and sample BVHs, plus a CC0 low-poly kit and `manifest.json` | 1.5 h | done | 01 |
| 05 | A | Characters: load VRMs, retarget Kimodo BVH, play a clip, planted feet | 2.5 h | done | 04 |
| 06a | B | Self-host Nemotron Nano 9B v2 (FP8) on the pod with vLLM (:8104, OpenAI-compatible, tool calling) | 1 h | dropped: use OpenRouter / OpenCode Zen instead | — |
| 06 | A | Nemotron client + agent loop on the server (tool calling, streamed steps), via OpenCode's free Nemotron now and swappable to NVIDIA's API later | 1.5 h | done (free tier rate-limits after ~30 calls: get a key for 08) | — |
| 07 | B | Text → concept image for props (pick a model, add an endpoint) | 1.5 h | done | 03 |
| 08 | A | Movie: the orchestrator splits a scene into shots and beats, and the world agent builds the set | 3 h | done | 04, 06 |
| 08b | A | Per-agent Nemotron routing (hosted super-vl-120b for orchestrator, lightning-30b for world/chat) with the fallback chain hosted → self-hosted Nano 9B → OpenCode → mock; re-cache the four test scenes | 1 h | todo | 08 |
| 09a | A | Movie page UI with a mocked scene script: agent log, world build from script, per-character timeline, play, export WebM | 2.5 h | done | 04, 05 |
| 09b | A | Movie: wire the real agents in, motion agent generates clips on the pod, director merges | 1.5 h | done (with 08: real agents over SSE, Kimodo clips, merge, export) | 08, 09a |
| 10 | A | Chat page: a character talks (Nemotron + browser voice) and demonstrates moves | 2 h | done (mock replies; live Nemotron path untested) | 05, 06 |
| 11 | A | Prop generation in the world agent (image → TRELLIS.2 → library) | 1.5 h | done (mechanics; the world agent calls it in 08) | 07, 08 |
| 12 | A | Demo: cache the demo scenes, record the video, write the submission | 2 h | todo | 09, 10 |
| 13 | A | Chat: remove the canned mock lines and suggestion chips ("Hi! I can show you a squat…"); Nemotron persona only | 0.5 h | done | 06 |
| 14 | A | Scale + placement: characters and props at consistent real-world size; grounded, no overlaps, positions that follow the script | 2 h | todo | 08 |
| 15 | A | World fill + backdrop: no empty island. Ground scatter (grass, flowers, rocks), a dense tree/hill ring, a painted sky/backdrop that fills the frame | 2.5 h | todo | 08 |
| 16 | A | Cinematic camera: the director picks shots per beat (wide, medium, close, side, over-the-shoulder, low), with cuts and moves (dolly, orbit, crane) | 2.5 h | todo | 08 |
| 17 | A | Time of day + weather: day/dusk/night lighting with glowing lamps and windows at night, plus rain/snow/fog. The orchestrator sets it from the prompt | 2 h | todo | 15 |
| 18 | A | Edit mode: select, move/rotate/scale, duplicate, delete, replace with a library item, regenerate a prop on the GPU | 3 h | todo | 14 |
| 19 | A | Camera paths: draw a keyframed camera path between two timestamps in edit mode; it overrides the director for that span | 2.5 h | todo | 16, 18 |
| 21 | A | Full pipeline check + optimization: load times, GLB sizes, caching, LLM call budget, GPU memory, bug bash | 2 h | todo | 13–17 |

**Cut rule.** If it's 6:00 am and task 09 isn't working, demo the Chat page plus a
Movie page with one generated world and the sample clips. A finished small demo
beats an unfinished big one.

## Details

**03 TRELLIS.2.** `gpu/asset_server.py` takes an image and returns a GLB, cached
on the volume. *Done when* the example image comes back as a GLB that loads in
the page through `toonify()`.

**04 Library.** `library/characters/` holds the two VRMs, `library/motions/` the
sample BVHs, and `library/props/` the GLBs. `library/manifest.json` records id,
file, category, real-world size, tags, license and source for each entry.
*Done when* there are at least 30 props loading at the right scale.

**05 Characters.** A BVH from Kimodo plays on a VRM in the storybook stage. Use
`post_processing` clips from the pod, with feet on the ground and no sliding.
Two clips should join without a pop. *Done when* a "walk, then wave" pair plays
cleanly. Compare `tmp/walk_true.bvh` against `tmp/walk_false.bvh`.

**06a Self-hosted Nemotron.** No sponsor key yet, so run `nvidia/NVIDIA-Nemotron-Nano-9B-v2-FP8` (10 GB, not gated) under vLLM on the pod, bound to localhost:8104 with an OpenAI-compatible API and tool calling, and add it to `serve.sh`, `tunnel.sh` and `setup.sh`. To make room, run Kimodo with `TEXT_ENCODER_DEVICE=cpu` (about 13 GB of VRAM freed). *Done when* a chat completion with a tool definition returns a correct tool call through the tunnel, and Kimodo and TRELLIS.2 still work.

**06 Nemotron.** There's no API key, so for now Nemotron runs through the locally installed **OpenCode CLI** (upgraded to 1.19.5; the free tier needs 1.18 or newer). Checked on 2026-11-07:
`opencode run --format json -m opencode/nemotron-3.5-lightning-free "..."` returns text. Calling `https://opencode.ai/inference/openai/v1` directly is refused (free models only work through the OpenCode client). `opencode serve` starts, but a `POST /session/{id}/message` test hung, so try it again or use `opencode run`. Models available: `nemotron-3.5-lightning-free` (fast), `nemotron-3.5-super-vl-free` (vision, for a future self-check), `nemotron-3-super-free` and `nemotron-3-ultra-free`.
Build `server/llm.py` with one interface, `complete(messages, json_schema=None) -> text/JSON`, and these backends: `opencode` (the default: a custom no-tools agent defined in a project `opencode.json`, or the serve API with tools off and our own system prompt), `nvidia` (`NVIDIA_API_KEY` + `https://integrate.api.nvidia.com/v1`) and `openai` (any `NEMOTRON_BASE_URL` + key). `LLM_BACKEND` in `.env` picks one, so switching to the sponsor's key later is one `.env` line. The agent loop does tool calling with our own JSON protocol, so it works on every backend, and streams each step to the browser over SSE. Move `/api/chat` onto it. *Done when* a test agent calls a dummy tool correctly through OpenCode Nemotron, the steps stream into the page, and Chat replies come from Nemotron (`source: nemotron`).

**07 Concept images.** Turn "a red wooden windmill, low-poly storybook style,
plain background" into a clean single-object image. *Done when* five prompts
give usable images in under 10 s each.

**08 Orchestrator + world.** Long scene text → JSON script (shots, cast,
beats of 10 s or less, props, terrain) → the world agent places library props
using layout code. *Done when* three different scenes produce sensible sets and
scripts.

**09a Movie UI (mocked).** The script format the orchestrator will emit, defined as JSON in `web/js/movie/script.js` with an example (the fisherman scene from `PLAN.md`). The page shows a streamed agent log (replayed from the mock), builds the set from library props, runs one timeline row per character, fetches each beat's clip from the motion server (`localhost:8101`, through the tunnel) or falls back to `library/motions`, merges with `web/js/characters/merge.js`, and plays and exports WebM. *Done when* the mocked fisherman scene plays end to end.

**09 Motion + director.** For each beat and each character: a Kimodo prompt, a
clip, and the facing and position worked out from the script. The director lines
the clips up on a per-character timeline, and the clips merge into one playback
that can be exported to WebM. *Done when* the scene in `PLAN.md` plays end to end.

**10 Chat.** Show a character in a small world with a chat panel. Replies come
from Nemotron and are spoken by the browser. "Show me X" triggers a Kimodo clip.
*Done when* a question gets a spoken answer and "show me a squat" performs one.

**11 Prop generation.** If the library has no match, generate a concept image,
run TRELLIS.2, normalize scale and pivot, `toonify()` it, and save it to
`library/`. *Done when* "a windmill" appears in a world.

**12 Demo.** The video plays from cached assets only. List every model and
license used.

**Order after 08:** 13 (quick) → 08b → 14 → 15 → 16 → 17 → 12 (demo, which must be recorded before the 12:00 pm deadline) → 18 → 19 → 21.
Before the deadline, work only on what improves the demo; 18–19 can continue after it.

**13 Chat cleanup.** Remove the mock's canned greeting and the "Hi Mira!" / "Show me a squat" chips. Mira greets in her own words from Nemotron, and the mock is used only when the LLM is down, with that shown clearly.

**08b Per-agent routing.** `llm.complete()` takes an agent name; `.env` maps agent → model (orchestrator and self-check: `nvidia/nemotron-3.5-super-vl-120b-a12b`; world, motion, director, chat: `nvidia/nemotron-3.5-lightning-30b-a3b`) on the `nvidia` backend, and on error or rate limit falls to the self-hosted Nano 9B (:8104), then OpenCode, then mock. The log and `/health` show which model answered each call. Re-run the four scenes in `library/scripts/` with `fresh=1` and keep the new caches. *Done when* the market plan has the thief grab the apple first and the keeper never "reaches for" it, the campfire friends start seated, and `/health` shows calls on the hosted models.

**14 Scale + placement.** Characters are 1.6–1.8 m; props use `size` from the manifest (generated props get a sensible `size_m` per category, since the fishing boat came out 10 m long because size was applied to height). Everything sits on the ground. Layout code keeps props off paths and away from characters' walk lines, and characters start and end where the script says (next to "the well", on "the dock"). *Done when* the three test scenes look right in screenshots, with no floating, sinking, giant or tiny items.

**15 World fill + backdrop.** Reference: the beach/forest still the user shared (dense trees, rocks and layered depth behind the action). Add instanced ground scatter, a ring of trees and hills to the horizon, distance fog, and a painted backdrop (a SANA panorama, or layered cards) instead of empty space. **Use paint-over where it holds up:** (a) the ground: render the blocked-out set top-down, have SANA img2img paint it (paths, dirt, grass patches, pebbles, small rocks) and apply that painting as the ground texture, which works from any camera because it's flat; (b) the far backdrop. Keep tall props as 3D models. *Done when* no camera angle in the demo shows bare ground or an empty sky edge.

**16 Cinematic camera.** The director agent (Nemotron, inside the 2–4-call budget, or rules from the script) gives each beat a shot type and a move, cutting between angles like a film edit. *Done when* the fisherman scene has at least 5 distinct shots with sensible cuts.

**17 Time of day + weather.** Lighting presets (dawn, day, dusk, night) with emissive windows and lamp glow at night (see the day/night city reference), plus particle rain/snow and fog. The script carries `time_of_day` and `weather`.

**18 Edit mode.** Toggle in the Movie page: click to select, a gizmo to move/rotate/scale, duplicate, delete, a "replace" picker from the library, and "regenerate" (calls `generate_prop` with a new seed). Edits are saved into the scene script.

**19 Camera paths.** In edit mode, pick a start and end time on the timeline and place camera keyframes in the scene; a spline camera follows that path for the span.

**20 (moved to Later).** The paint-over look is only safe for the far backdrop, which is covered in 15. See Later.

**21 Full check + optimization.** Time every step of a fresh prompt, shrink slow loads, confirm the cache hit paths, fix the bugs found, and update `docs/STATUS.md`.

## Later

- **Paint-over projection (was 20).** It fits a fixed or near-fixed camera, like the reference village. With our moving film camera, a single projected painting stretches and leaves unpainted areas behind objects, and it bakes in one light direction. The workable 3D version: paint each prop from 4–6 views, blend the projections, and bake them into the prop's own texture, so it reads correctly from any angle. Before the deadline, use it only for the distant backdrop (15), where parallax is small; generated props already get painted-style textures from the SANA concept image through TRELLIS.2.

- Self-check loop: screenshot → Nemotron vision → agent fixes problems.
- Comparing image→3D generators (Hunyuan3D, SAM 3D), and a motion-model comparison.
- Rivers and hills in the terrain, and reactive water and grass.

## Found along the way

- 06a dropped (2026-11-07): Nemotron is hosted with tool calling on OpenRouter
  (`https://openrouter.ai/api/v1`: `nvidia/nemotron-3-super-120b-a12b`, `nvidia/nemotron-3-nano-30b-a3b`,
  `nvidia/nemotron-3.5-lightning`, plus `:free` variants) and on OpenCode Zen (`https://opencode.ai/zen/v1`:
  `nemotron-3.5-super-vl-free`, `nemotron-3.5-lightning-free`). That beats a self-hosted 9B and uses no VRAM.
  Task 06 and the "through the NVIDIA API" line in `CLAUDE.md` should change to match.
  Tool calling through either one hasn't been tested yet, because there's no key in `.env`.
- The pod container is capped at 50 GB of RAM and about 7.6 CPUs (cgroup). With Kimodo's text encoder
  on the CPU (`TEXT_ENCODER_DEVICE=cpu`), the OOM killer took TRELLIS.2 and Kimodo. When it did fit,
  a 5 s clip took 16 s, or 6 to 8 s with `OMP_NUM_THREADS=7` (3.8 s on the GPU). That change was reverted.
- Left over from 06a: a vLLM venv at `/opt/venvs/vllm` (container disk, goes away on reset) and the
  Nemotron-Nano-9B-v2-FP8 weights (~10 GB) in `/workspace/hf` (billed as volume storage; delete them if
  we don't self-host).
- Kimodo prints LoRA weights as "MISSING" while loading its LLM2Vec text encoder.
  Check whether the text encoding is right (task 05).
- `.claude/` is gitignored, so `.claude/launch.json` (`animo-world-server`,
  `animo-world-web`) exists only in this checkout.
- Run the app with `animo-world-server`, since FastAPI serves `web/` at `/`. The
  server venv is `server/.venv`.
- three r160 `MeshToonMaterial` has no `flatShading`. Use `faceted(geometry)` from
  `web/js/toon.js`, and run every loaded GLB through `toonify()`.
- Outlines in `web/js/look.js` use vertex normals, so check them on TRELLIS
  meshes in task 11.
- Library: `web/js/library.js` has `loadManifest()`, `findProps()` and
  `loadProp(idOrEntry)`. Props come back toonified, scaled to `size[1]` meters,
  pivot at bottom-center. `/props.html?labels` shows all 45 with 1.7 m figures.
  FastAPI serves `library/` at `/library/`; the static dev server can't.
- The two VRMs' VRoid license says "redistribution: disallow" and "credit:
  necessary". That's fine in a private repo, but credit SherryKatzu and
  Rarestgrass in the submission (task 12), and don't publish the files.
- The old project's 5 props have no recorded license or origin (trimesh exports,
  probably image→3D). They ship without normals; `toonify()` now computes them.
  `house.glb` has a dark ground disc around it that makes its footprint 7 m.
- Kenney's Fantasy Town `windmill`/`watermill` are only the sails and wheel,
  and Pirate `tower-watch` is a tower top, so they were left out. A full windmill
  is still a good test for task 11.
- Characters (task 05): `web/js/characters/index.js` has `loadCharacter(id)`,
  `hero.makeClip(bvh, name)`, `hero.setClips([...])` and `hero.update(dt)`.
  `/characters.html` plays walk → wave (`?char=avatar_female`, `?clips=a,b`,
  `?live`, `?t=3.2`, `?marks`). Retargeting matches per-bone anatomical frames
  measured on `persona_idle.bvh` frame 0, because Kimodo's rest pose is
  degenerate (every bone along +X).
- Kimodo `post_processing` really fixes sliding. In `walk_true.bvh`, a planted
  ankle moves 0.0 cm/s with the toe at exactly 2.0 cm. In `walk_false.bvh`, a
  planted ankle drifts 3–19 cm/s. On the VRM with leg IK, a planted foot moves
  0.01 cm/s (median) and 0.24 cm/s (p95); without IK it's 1 / 15.7 cm/s.
  Always request `post_processing: true`.
- The pod was unreachable during task 05 (the tunnel timed out), so "walks
  forward" is the cached `tmp/walk_true.bvh` (now `library/motions/walk_forward.bvh`),
  and "waves hello" is `persona_wave.bvh`. Retry `?live` once the pod is up. That
  walk clip raises its right hand to head height around 1 s: it's in Kimodo's
  output, not a retargeting bug.
- three-vrm 2.x renames VRM 0 thumbs to VRM 1 names (`thumbMetacarpal`,
  `thumbProximal`, `thumbDistal`). VRoid MToon materials draw in the transparent
  pass, so overlays need `transparent: true` to draw on top.
- Merging only tested standing → standing (walk ends stopped). Joining mid-stride
  clips may need the overlap moved to a double-support frame (task 09).
- 03: TRELLIS.2 takes about 47 s per prop at `quality=512` (the default) and about 220 s at
  `1024_cascade`, and each GLB is about 3 MB. While it's generating, the asset server
  doesn't answer `/health`, because it handles one job at a time. Pre-generate demo props.
- 03: the pod's SSH sometimes times out for a minute, so retry before assuming the
  pod is down. `bash /opt/app/serve.sh status` on the pod shows both servers.
- 07: the image server on :8103 runs NVIDIA SANA-Sprint 1.6B (Apache-2.0; its text encoder is
  Gemma-2-2B-IT under the Gemma Terms of Use). `POST /generate-image {prompt, seed}` returns a PNG
  in about 1.7 s, and `POST /generate-prop {prompt}` returns a GLB in about 45 s. Both return an
  `X-Image-Key` header, and `GET /image/{key}.png` fetches the image again. Images and their
  prompts are cached in `/workspace/cache/images/{key}.png|.json`. The house style is added to the
  prompt unless `raw: true`. Samples and a screenshot of the windmill GLB are in `tmp/07/`.
- 07: SANA ignores negatives ("no base, no grass"), and naming them seems to make them appear, so
  the style prompt is worded positively. Even so, most props come with a small ground slab or grass
  disc, because "low-poly game asset" pulls them in strongly. TRELLIS keeps it in the mesh (the
  windmill GLB has one). Task 11 should trim or accept it, or try another seed.
- 07: the windmill's thin lattice sails come out of TRELLIS.2 as rough spikes. For props with
  thin parts, ask for "solid, chunky" versions in the prompt (task 11).
- 07: diffusers 0.35 ignores `dtype=` and silently loads in fp32 (about 17 GiB peak, and fp8
  casting then breaks Gemma), so keep `torch_dtype=`. Cast to fp8 before `.to("cuda")`.
- 09a: the scene-script format is `web/js/movie/script.js` (documented at the top, checked by
  `validateScript()`), and the fisherman mock is `web/js/movie/mock.js`. Headings are degrees, 0 = +z.
  A beat's `to` turns the clip toward the target and stretches its ground path by at most ±35 %, so
  the orchestrator (task 08) must pick durations that roughly fit the distance. Measured Kimodo
  distances (male rig): "A person walks forward." 5 s ≈ 7.6 m, "A person jogs forward." 5 s ≈ 12.6 m,
  "A child runs forward fast." 6 s ≈ 11 m. Clips often stand still for 0.4–1.2 s first; "A child runs
  forward happily." stood for 2 s and then covered only 5.6 m.
- 09a: "A person sits down on a bench and rests." moves the hips about 0.27 m forward while sitting.
  Kimodo has no seat constraint, so put the bench where the hips end, not where the walk ends.
- 09a: two beats with the same prompt and duration get the same clip (cached per prompt), so both
  characters sit identically. The script has no `seed` yet; 09b could add one per beat.
- 09a: the motion server's `X-Cache` header can't be read cross-origin (no `expose_headers` in its
  CORS setup), so the page can't tell a pod cache hit from a fresh generation. That fix is in `gpu/`.
- 09a: Movie page flags: `#movie?autoplay` runs on load, `?fast` skips the log's typing delays,
  `?t=12` stops at 12 s, `?motion=URL` points at another motion server. `window.animo.pages.movie`
  has `make()`, `seek(t)`, `play()`, `exportMovie()` and `state`. The export is the canvas size
  (2880×1800 on a retina screen): about 10.8 MB for the 23 s film as VP9 WebM.
- 09a: navigating the browser pane to the same URL with a different `#hash` doesn't reload the
  page, and modules were served stale. The server now sends `Cache-Control: no-cache`.
- 10: `POST /api/chat {messages} -> {reply, demonstrate: null | {prompt, duration}, source}` is in
  `server/chat.py`. Without `NVIDIA_API_KEY` it answers from a rule-based mock (greetings, "show me /
  teach me / how do I <known move>"). With the key it calls Nemotron (`NEMOTRON_MODEL`, default
  `nvidia/llama-3.3-nemotron-super-49b-v1.5`) through urllib, with `CHAT_SYSTEM_PROMPT` asking for JSON;
  `parse_reply()` strips `<think>` blocks and code fences. That path has never run: check it once the
  key is in `.env` (task 06 can reuse the prompt and pick the model).
- 10: the Chat page (`web/js/chat/`) reuses `buildSet()` and `motionFor()` from `web/js/movie/` for
  the set and the Kimodo calls (browser cache, library fallback). `performer.js` merges every change of
  motion from the current pose with `mergeClips()`, so talking can start mid-idle and a demo can start
  mid-sentence. `#chat` flags: `?say=show+me+a+squat` sends a message on load, `?motion=URL` as on Movie.
  `window.animo.pages.chat` has `send(text)`, `voice` and `state`.
- 10: the browser pane picked "Samantha" (macOS). The voice ranking is in `web/js/chat/voice.js`;
  a Premium/Enhanced voice wins if installed (System Settings → Accessibility → Spoken Content).
- 10: "A person does a slow bodyweight squat and stands back up." (5 s) took 6.3 s on Kimodo the first
  time; the squat itself is about 3 s and the hips drop from 0.87 m to 0.38 m.
- 10: the Movie page before "Make movie" shows the bare island close up and blurred by the tilt-shift
  (same on a fresh `#movie` load), not the whole island as the old placeholder did.
- 11: `POST /api/props/generate {name, prompt?, size_m?, category?, seed?} -> {entry, cached, seconds}` wraps
  `server/tools/generate_prop.py` (`generate_prop()` plus `TOOL`, an OpenAI-style schema for task 08). The id is
  the slugged name; a manifest hit returns at once. Otherwise it starts `gpu/tunnel.sh` if :8103 is closed, calls
  `/generate-prop` with ", solid chunky shapes, thick sturdy parts" appended, and writes
  `library/props/generated/{id}.glb|.png|.json` plus a manifest entry (`source: "generated"`, license notes).
  One generation at a time (a lock). The server venv now needs numpy (`server/requirements.txt`).
- 11: `server/tools/glb.py` `normalize_glb()` trims the ground slab without trimesh: footprint radius per 1 % height
  band against the body's radius at 15–25 %; a bottom band ≥1.25× wider is a slab, cut where it narrows back to
  1.12×, and triangles with centroids below the cut are dropped (orphan vertices too, so bounds stay right). Both
  windmills trimmed cleanly (cut at 10 % and 12 %, about 40 % of the triangles were grass and rocks), leaving the
  tower open at the bottom, which doesn't show. A prop that is meant to be wide at the bottom (a bell, a tent)
  could be trimmed wrongly; `trim_base=False` turns it off, but the HTTP endpoint doesn't expose that yet.
- 11: the first windmill took 64 s on the pod (the task-07 estimate was 45 s). The pod caches by prompt and seed,
  so regenerating the same prompt takes about 1 s; a new seed is needed for a different result. The windmill's
  sails are still thin, short and a little spiky, even with the "chunky" prompt.
- 11: in the scene script, a prop whose `library` id isn't in the manifest is generated before placement, using an
  optional `generate: {prompt, size_m, category}` (see `script.js`). The fisherman mock places the windmill at
  (4.5, −11). The world log shows "generating windmill…", and the next run shows "generated earlier, from the
  library" (the GLB loads in about 30 ms).
- 11: when the browser pane is hidden, the Movie page's render loop stops, so screenshots go stale. Calling
  `setInterval(() => animo.look.render(), 200)` from the console keeps them current.
- Cleanup pass: `#movie?autoplay&fast` doesn't start the movie on load (checked 2026-11-07); clicking "Make movie" works. The chat server's Nemotron base URL is hard-coded to the hosted API, so task 06 must read `NEMOTRON_BASE_URL` (self-hosted pod by default).
- 06: `server/llm.py` `complete(messages, json_schema=None, shape=None)` is the only LLM entry point. `LLM_BACKEND`
  (`opencode` default, `nvidia`, `openai`) and `NEMOTRON_MODEL` in `.env` pick it, so a sponsor key is a `.env`
  change. With a schema it shows the model a filled-in example (not the schema: lightning copied the raw
  schema back as its answer), repairs the JSON (think blocks, fences, trailing commas, smart or single quotes,
  cut-off objects), checks `required`, types and enums, and re-asks with the problem. `llm.CALLS` records every
  call's seconds; `/health` shows `config.llm` {backend, model, ready, calls, median_s}.
- 06: OpenCode's free tier only accepts OpenCode's stock agent with its full tool list. A custom agent, tools
  turned off, or `permission: deny` (which drops the tools) all get "Free usage limit reached". So
  `opencode run --pure` runs in `~/.cache/animo-world/opencode/` with an `opencode.json` that sets every
  permission to `ask`, and the non-interactive `run` auto-rejects every tool call. Without that, the model ran a
  bash command it was asked to run in a test. Every call carries about 8k tokens of OpenCode's coding-agent
  prompt, and our system prompt and conversation go in as one flattened user message. `opencode run` hangs if
  stdin is an open pipe, so it gets `/dev/null`. Each call also leaves a session in OpenCode's local storage.
- 06: Nemotron 3.5 lightning latency through `opencode run` (process start included), measured 2026-11-07:
  small JSON calls and agent steps took 1.4–3.8 s, usually 2–3 s. Chat replies took 2.6–9.7 s, with one at
  19.9 s. The test agent's whole run (3 calls, 2 tool calls) took 6–8 s. So budget about 3 s per orchestrator
  call, and about 10 s when it's slow.
- 06: **the OpenCode free tier rate-limits.** After about 30 calls in about 30 minutes, every call (even from a
  folder with no config) got "Free usage limit reached", and OpenCode retries that quietly for minutes. The client
  now spots it on stderr in about 1 s, raises `LLMError`, and skips OpenCode for `OPENCODE_COOLDOWN_S` (120 s),
  so Chat falls back to the mock at once. The limit hit around 20:47 (local time) and was still on at 20:54; how long it lasts isn't known yet.
  For task 08 (several calls per movie) and the demo, cache every orchestrator result in `library/`, and get a
  key: `LLM_BACKEND=openai` with `NEMOTRON_BASE_URL=https://openrouter.ai/api/v1` and an OpenRouter key
  (`nvidia/nemotron-3.5-lightning:free` or a paid Nemotron), or `LLM_BACKEND=nvidia` with `NVIDIA_API_KEY`.
  The nvidia and openai backends haven't been run (no key).
- 06: agents: `server/agents/loop.py` has `Agent(name, role, tools, final_schema, max_steps)` and `Tool(name,
  description, parameters, fn)`. `run(agent, task)` yields `{agent, kind: thought|call|result|final|error, text,
  ms, data?}`. Each turn the model returns `{"thought", "call": {"tool", "args"}}` or `{"thought", "final"}`. An
  unknown tool, bad args or a raised exception go back to the model as the tool result, and it corrected itself
  ("old mill" → error → "windmill"). `GET /api/agents/{name}/run?task=` streams it as SSE (`event: done` carries
  per-call seconds). `web/js/agent-stream.js` has `streamAgent()` and `logStep()` for the Movie page (09b);
  `/agents.html?run` shows the test agent (`server/agents/test_agent.py`, a `distance` tool over five places).
- 06: `/api/chat` now goes through `llm.complete()` with `REPLY_SCHEMA` (30 s timeout, 1 re-ask). It returns
  `source: "nemotron" | "mock"` and `seconds`; the Chat page already shows "brain: Nemotron". `CLAUDE.md` still
  says Nemotron goes "through the NVIDIA API" (a main-session edit).
- 08: `server/agents/movie.py`. A movie costs **2 Nemotron calls**: the orchestrator returns a story plan (cast,
  named places, beats with "A person ..." prompts, `move_to`/`face`/`after`/`with`, shots, no coordinates), then
  `search_library` runs per place (code), and the world agent makes one call to choose a library prop or
  `generate` (≤2) per place, plus decor. `layout()` (code) does positions along a walking route, the pond, seat
  and stand slots, walk durations from distance and speed, idle fillers, shots and decor; then a Python port of
  `validateScript`. Raw answers are cached in `library/scripts/` per scene text, so a replay costs 0 calls and
  layout changes still apply. `GET /api/movie/plan?scene=&fresh=1` streams it as SSE. Fallback: closest cached
  scene by word overlap, then the mock. `.env` now has `LLM_BACKEND=openai`, `NEMOTRON_BASE_URL=http://localhost:8104/v1`,
  `NEMOTRON_MODEL=nemotron`, `NEMOTRON_NO_THINK=1` (self-hosted Nano 9B v2 on Brev); `llm.py` re-reads `.env` on change.
- 08: timings (2026-11-07, Nano 9B v2 via vLLM): orchestrator 6.3–9.3 s, world 2.6–8.2 s, layout 2–6 ms. Market
  chase 28 s end to end (5 clips), campfire 45 s (7 clips), fisherman 43 s (8 clips). Full e2e, a new prompt
  (girl, lighthouse, grandpa's rowboat): plan 7.9 s → script 16.1 s → generated `wooden-cottage` 52 s and
  `stone-lighthouse` 25 s → set at 93.7 s → 9 clips (Kimodo 3.3–4.2 s each) → film ready at 120.9 s (merge 36 ms)
  → WebM export 24.5 s, 11.4 MB. Cached replays of all four scenes take 0.7–7.9 s.
- 08: Nano 9B v2 plans are thin and need repair (all in `repair_plan`): it puts `move_to` on action beats
  ("trips over the cart" + move_to cart → go there, then act; "stands up" + move_to → stand up, then go), invents
  abstract places ("open ground", merged into the first real place), says `water: true` for a fountain (now only if
  the scene text names water), skips actions (the market plan dropped "gives the apple back" once), gives both
  thief and keeper `avatar_male`, and never starts the campfire friends sitting despite the prompt rule. Each Kimodo
  clip starts standing, so a sit followed by "laughs" stands up. The world agent picked a rock for "well" and, until
  NO MATCH hints were added, a rock for a lighthouse; "cottage" finds nothing (`house` lacks a cottage tag).
- 08: "slow" walks fall short: several walk beats hit the director's ×1.35 stretch limit even at 0.85 m/s. Measure
  Kimodo's "walks forward slowly" distance. In the fisherman film the director camera stood behind the dock, which
  filled the frame (fixed shot angles in `camera.js`, 09a).
- 08 review (main session, 2026-11-07 late): the four cached scenes replay; the market film builds its set, plays 10.1 s with 3 shots, no console errors. Per-agent routing from `docs/STATUS.md` was not built: `llm.py` has one backend, so every cached plan is Nano 9B. Market plan: the keeper "reaches for apple" and the thief "hands over the apple and runs away"; campfire: friend2 "stands up from sitting" for 9 s, then stands still while friend1 dances. → 08b.
- 08: one "the scene script is invalid" console error remains in the pane's log. It was raised during the campfire run
  that hit the duplicate-beat-id bug (fixed); the browser pane keeps the log across navigations, so I couldn't prove
  it isn't from the later check of all four cached scenes, though none of those runs logged an error in the agent log.
- 13: Mira's opening line is a `/api/chat` call with empty `messages`; the server adds a stage-direction
  user turn (`ARRIVAL` in `server/chat.py`) so the model never sees a history that starts with the
  assistant. A mock reply carries `source: "mock"` plus `error`, and the page shows a dashed bubble,
  "Nemotron offline: mock reply" and a red footer, and logs a console warning.
- 13: there's no switch to make the LLM unreachable without editing `.env`; the offline check ran a second
  server with `llm._call` patched to raise. An `LLM_BACKEND=off` (or similar) would make that a one-liner,
  maybe in 08b.
- 13: the greeting is spoken on page load, before any click; Chrome may refuse `speechSynthesis` without a
  user gesture, so the first line may be text-only until the user interacts. Not checked by ear.
- 13: `?say=` must come before the hash (`/?say=show+me+a+squat#chat`). Navigating to the same URL that
  differs only in the hash doesn't reload the page, so a "reload" that way runs stale JS.

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
| 06a | B | Self-host Nemotron Nano 9B v2 (FP8) on the pod with vLLM (:8104, OpenAI-compatible, tool calling) | 1 h | todo | — |
| 06 | A | Nemotron client + agent loop on the server (tool calling, streamed steps) | 1.5 h | todo | 06a (or `NVIDIA_API_KEY`) |
| 07 | B | Text → concept image for props (pick a model, add an endpoint) | 1.5 h | done | 03 |
| 08 | A | Movie: the orchestrator splits a scene into shots and beats, and the world agent builds the set | 3 h | todo | 04, 06 |
| 09a | A | Movie page UI with a mocked scene script: agent log, world build from script, per-character timeline, play, export WebM | 2.5 h | done | 04, 05 |
| 09b | A | Movie: wire the real agents in, motion agent generates clips on the pod, director merges | 1.5 h | todo | 08, 09a |
| 10 | A | Chat page: a character talks (Nemotron + browser voice) and demonstrates moves | 2 h | done (mock replies; live Nemotron path untested) | 05, 06 |
| 11 | A | Prop generation in the world agent (image → TRELLIS.2 → library) | 1.5 h | done (mechanics; the world agent calls it in 08) | 07, 08 |
| 12 | A | Demo: cache the demo scenes, record the video, write the submission | 2 h | todo | 09, 10 |

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

**06 Nemotron.** The server talks to an OpenAI-compatible base URL from `.env`: `NEMOTRON_BASE_URL` defaults to `http://localhost:8104/v1` (the self-hosted pod model), or to `https://integrate.api.nvidia.com/v1` when `NVIDIA_API_KEY` is set. Pick the
Nemotron model that handles tool calling best and record it in
`docs/decisions.md`. A generic agent loop takes tools and streams each step to
the browser over SSE. *Done when* a test agent calls a dummy tool correctly
and the steps show up in the page.

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

## Later

- Self-check loop: screenshot → Nemotron vision → agent fixes problems.
- Comparing image→3D generators (Hunyuan3D, SAM 3D), and a motion-model comparison.
- Rivers and hills in the terrain, and reactive water and grass.

## Found along the way

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
- 10: `web/js/demo.js` (the primitive test village) is no longer used by any page.
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

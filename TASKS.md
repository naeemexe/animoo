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
| 03 | B | TRELLIS.2 asset server on the pod (:8102) | 2 h | doing | — |
| 04 | A | Library: the old project's VRMs, props and sample BVHs, plus a CC0 low-poly kit and `manifest.json` | 1.5 h | doing | 01 |
| 05 | A | Characters: load VRMs, retarget Kimodo BVH, play a clip, planted feet | 2.5 h | todo | 04 |
| 06 | A | Nemotron client + agent loop on the server (tool calling, streamed steps) | 1.5 h | waiting | `NVIDIA_API_KEY` in `.env` |
| 07 | B | Text → concept image for props (pick a model, add an endpoint) | 1.5 h | todo | 03 |
| 08 | A | Movie: the orchestrator splits a scene into shots and beats, and the world agent builds the set | 3 h | todo | 04, 06 |
| 09 | A | Movie: the motion agent makes clips, the director merges them on a timeline, play and export | 3 h | todo | 05, 08 |
| 10 | A | Chat page: a character talks (Nemotron + browser voice) and demonstrates moves | 2 h | todo | 05, 06 |
| 11 | A | Prop generation in the world agent (image → TRELLIS.2 → library) | 1.5 h | todo | 07, 08 |
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

**06 Nemotron.** The server talks to `integrate.api.nvidia.com/v1`. Pick the
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

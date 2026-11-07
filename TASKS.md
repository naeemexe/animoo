# Tasks

Each task gets **one Claude session**. Work top to bottom unless a task is
waiting on something. Status: `todo` · `doing` · `waiting` · `done`.

| # | Task | Status | Needs first |
|---|---|---|---|
| 01 | Project skeleton: page + backend, both running locally | todo | — |
| 02 | Stylized look: toon shading, outlines, warm light, tilt-shift | todo | 01 |
| 03 | Starter asset library from a free CC0 kit, plus a manifest | todo | 01 |
| 04 | Connect Nemotron, pick the model, prove tool calling works | waiting | your API key |
| 05 | World agent: prompt → plan → tool calls → world on screen | todo | 03, 04 |
| 06 | Terrain: paths, grass, water, gentle hills | todo | 02 |
| 07 | Research: compare image→3D generators on the GPU | waiting | Brev credit |
| 08 | GPU server on Brev: start/stop scripts, generation endpoints, cost log | todo | 07 |
| 09 | `generate_asset` tool: missing prop → new 3D model → library | todo | 05, 08 |
| 10 | Characters: pick stylized rigged characters that match the look | todo | 02 |
| 11 | Research: why the old motion looked unnatural, and which motion model to use | todo | — |
| 12 | Motion pipeline with cleanup (planted feet, smooth joins) | todo | 08, 10, 11 |
| 13 | Agent can add characters and make them act in the world | todo | 05, 12 |
| 14 | Self-check: screenshot → Nemotron vision → agent fixes problems | todo | 05 |
| 15 | Demo video and submission write-up | todo | all you want shown |

## Details

**01 Project skeleton.** `web/` holds a static three.js page with no build
step. `server/` is a FastAPI app with a `/health` route. `.env.example` lists
every key. Both start from `.claude/launch.json`. *Done when* the page shows a
ground plane and calls `/health` with no console errors.

**02 Stylized look.** Tune the renderer against the village reference image.
*Done when* a screenshot of a few boxes and spheres already reads as "storybook".

**03 Starter library.** Import a CC0 low-poly kit into `library/`. Each entry in
`library/manifest.json` records id, file, category, real-world size, footprint,
tags, license and source. *Done when* there are at least 30 assets loading in
the scene at the right scale.

**04 Nemotron.** Make a backend call to the hosted API. Compare the live Nemotron
models on JSON output and tool calling, then write down the choice in
`docs/decisions.md`. *Done when* a test prompt makes Nemotron call a dummy tool
correctly.

**05 World agent.** Run the agent loop on the backend with the tools
`search_library`, `set_terrain` and `place`. Code decides exact positions;
Nemotron decides what goes in and roughly where. The UI streams the steps.
*Done when* three different prompts each produce a sensible world.

**06 Terrain.** *Done when* a prompt with "a river through the village" shows
one.

**07 Image→3D research.** Run TRELLIS.2, Hunyuan3D 2.1 and SAM 3D on the same 5
props. Measure time, quality, VRAM, license, and how well the results fit our
style after our renderer. Write it up in `docs/research/image-to-3d.md`. Keep
GPU time under 3 hours.

**08 GPU server.** *Done when* one script starts the Brev box, one stops it,
`/generate-asset` and `/generate-motion` respond, and `docs/gpu-log.md` is updated.

**09 generate_asset.** Text → concept image in our style → 3D → cleanup (put the
pivot on the ground, normalize scale, reduce polygons) → saved to the library
with its prompt. *Done when* asking for "a red wooden windmill" adds one to the
world and to the library.

**10 Characters.** Pick characters whose license allows use and whose look
matches ours. They need to be rigged so the motion data fits them.

**11 Motion research.** List every cause of the old stiffness: padded clips
being looped, sliding feet, the fixed crossfade, travel clamping. Compare Kimodo
with other current text-to-motion models. Write it up in
`docs/research/motion.md`, and add the fixes here as new tasks.

**12 Motion pipeline.** *Done when* a three-step action plays with no foot
sliding and no pop at the joins, shown with before/after clips.

**13 Characters in the world.** *Done when* the example prompt in the README
plays end to end.

**14 Self-check.** *Done when* a deliberately broken scene (a floating prop, a
character inside a wall) gets noticed and fixed.

**15 Demo.** Record the video from cached assets only, write the submission
text, and list every model and license used.

## Found along the way

_Sessions add new bugs and ideas here. They become numbered tasks once they're
picked up._

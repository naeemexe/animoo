# Tasks

**Deadline: Sunday 2026-11-08, 12:00 pm.** That's under 24 hours, so only
what's needed for a working demo is in scope. Everything else sits under
**Later**.

Each task gets **one Claude session**. There are two tracks, and they touch
different folders, so **one session from each track can run at the same time**:

- **Track A, app** (`web/`, `server/`, `library/`): runs on the laptop, no GPU.
- **Track B, GPU** (`gpu/`): runs on the Brev box.

Status: `todo` · `doing` · `waiting` · `done`

| # | Track | Task | Budget | Status | Needs first |
|---|---|---|---|---|---|
| 01 | A | Skeleton + stylized look: page, backend, toon shading, outlines, warm light | 2.5 h | todo | — |
| 02 | A | Starter library: a CC0 low-poly kit plus `manifest.json` | 1.5 h | todo | 01 |
| 03 | A | Nemotron connection: pick the model, prove tool calling | 1 h | waiting | API key in `.env` |
| 04 | A | World agent: prompt → plan → tool calls → world on screen (streams its steps) | 3 h | todo | 02, 03 |
| 05 | B | GPU box: Brev up, TRELLIS.2 serving `/generate-asset`, start/stop scripts, cost log | 3 h | waiting | Brev code |
| 06 | B | Kimodo serving `/generate-motion` on the same box | 1.5 h | todo | 05 |
| 07 | A | `generate_asset` tool: missing prop → image → 3D → cleanup → library | 2 h | todo | 04, 05 |
| 08 | A | Characters act in the world: add character, animate, planted feet | 3 h | todo | 04, 06 |
| 09 | A | Demo: pre-generate and cache the demo scenes, record the video, write the submission | 2 h | todo | 07, 08 |

That's about 20 hours of work, done as about 14 hours of real time across the
two tracks, which leaves some slack. **Lock what's working by 9:00 am.**
After that, only task 09 is in progress.

**Cut rule.** If it's 6:00 am and 08 isn't working, the demo becomes the world
agent plus prop generation, with one sample motion. A finished smaller demo
beats an unfinished bigger one.

## Details

**01 Skeleton + look.** `web/` holds a static three.js page with no build
step. `server/` is FastAPI with `/health`. `.env.example` lists every key.
`.claude/launch.json` starts both. The renderer gets toon shading, soft
outlines, warm grading and tilt-shift. *Done when* a screenshot of a few boxes
and spheres on the ground already reads as "storybook", with no console errors.

**02 Starter library.** Each manifest entry records id, file, category,
real-world size, tags, license and source. *Done when* there are at least 30
assets loading at the right scale.

**03 Nemotron.** Use the hosted API at `integrate.api.nvidia.com/v1`. Pick a
Nemotron model that does tool calling well, and record the choice in
`docs/decisions.md`. *Done when* a test prompt calls a dummy tool correctly.

**04 World agent.** Tools: `search_library`, `set_terrain` (ground, a path, a
water patch) and `place`. Code decides exact positions; Nemotron decides what
goes in and roughly where. The UI shows each step as it happens, which is the
"beyond a chatbot" part judges will see. *Done when* three different prompts
each make a sensible world.

**05 GPU box.** TRELLIS.2 goes straight in. There's no time for a comparison
run. *Done when* `gpu/start.sh` and `gpu/stop.sh` work, a test image returns a
GLB, and `docs/gpu-log.md` has its first entry.

**06 Kimodo.** It needs `HF_TOKEN` with access to Llama-3-8B-Instruct. *Done
when* `/generate-motion` returns a clip for "a person waves".

**07 generate_asset.** Text → concept image in our style → TRELLIS.2 → put the
pivot on the ground, normalize scale, reduce polygons → saved to the library
with its prompt. *Done when* "a red wooden windmill" shows up in the world and
in the library.

**08 Characters.** Use stylized rigged characters with a license that allows
use, and retarget the Kimodo output onto them. Feet stay planted, and
consecutive clips join without a pop. *Done when* the README example plays end
to end.

**09 Demo.** The video plays from cached assets only. List every model and
license used.

## Later (after the deadline, or only if there's spare time)

- Self-check loop: screenshot → Nemotron vision → agent fixes problems.
- Comparing image→3D generators (Hunyuan3D, SAM 3D).
- Deeper motion research and a model comparison.
- Rivers and hills in the terrain, and reactive water and grass.

## Found along the way

_Sessions add new bugs and ideas here._

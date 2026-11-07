# Plan

Deadline: **Sunday 2026-11-08, 12:00 pm**. Track: **NVIDIA Nemotron, "beyond a
chatbot"**. GPU: one RunPod A40 (see `docs/gpu-log.md`).

## 1. The product: two pages

**Chat page.** A character stands in a small storybook world and talks with
you. Nemotron writes the replies, and the browser speaks them. If you ask
it to show you something ("how do I do a squat?"), it generates that motion and
performs it.

**Movie page.** You describe a longer scene:

> "At sunrise an old fisherman walks out of his hut, stretches, waves at a kid
> running past the well, and then they both sit on the dock."

A team of Nemotron agents turns that into a short animated film:

```
                       ┌──────────────────────┐
  long scene text ───▶ │  Orchestrator agent  │  breaks the scene into shots and beats
                       └──────────┬───────────┘  (who does what, for how long)
             ┌────────────────────┼─────────────────────┐
             ▼                    ▼                     ▼
     ┌───────────────┐   ┌────────────────┐    ┌────────────────┐
     │  World agent  │   │  Motion agent  │    │ Director agent │
     │ terrain, props│   │ one short clip │    │ timing, facing,│
     │ (library or   │   │ per character  │    │ camera, merge  │
     │  generate)    │   │ per beat       │    │ into one film  │
     └──────┬────────┘   └───────┬────────┘    └───────┬────────┘
            ▼                    ▼                     ▼
      TRELLIS.2 (GPU)       Kimodo (GPU)         timeline in the browser
      image → GLB           text → BVH           → play → export WebM
```

Kimodo produces clean clips only up to about 10 seconds, so splitting a long
scene into short beats is what makes long, natural-looking scenes possible. The
UI shows every agent step live, so judges can see the multi-step work as it
happens.

## 2. How it fits the track

| Track requirement | Where we meet it |
|---|---|
| Beyond a chatbot | The output is an animated 3D film, and Chat can demonstrate motion. |
| Multi-step workflows | Orchestrator → world, motion and director agents → merge. |
| Tool integration | `search_library`, `generate_prop`, `place`, `set_terrain`, `generate_motion`, `add_to_timeline`. |
| Real-world applicability | Previs and storyboarding for small film teams, plus teaching physical moves. |

## 3. Architecture and repo layout

```
web/                  static three.js, no build step
  index.html          shell with the Chat | Movie switch
  js/look.js …        storybook renderer (done in task 01)
  js/chat/            chat page
  js/movie/           movie page: agent log, timeline, playback, export
  js/characters/      VRM loading, BVH retargeting, clip merging
server/               FastAPI: serves web/ and runs the agents
  agents/             orchestrator, world, motion and director agents (Nemotron)
  tools/              library search, GPU calls, layout math
library/              props (GLB + manifest.json), characters (VRM), cached clips
gpu/                  RunPod side: setup.sh, motion_server.py, asset_server.py, tunnel.sh
docs/                 gpu-log.md, decisions.md
```

- **Nemotron** runs hosted on build.nvidia.com (OpenAI-compatible API), so it
  uses no GPU time. The key lives in `.env` and is only read by the server.
- **The GPU servers** run on the pod, bound to its localhost: motion on :8101
  and assets on :8102. `gpu/tunnel.sh` forwards both to the laptop.
- **Everything generated is cached**, on the pod's volume and in `library/`, so
  the demo can replay without the GPU.

## 4. Models

| Job | Model | Where | Status |
|---|---|---|---|
| Agents and chat | Nemotron (hosted) | build.nvidia.com | needs `NVIDIA_API_KEY` |
| Text → motion | Kimodo SOMA-RP v1.2 | pod :8101 | **working**, about 4 s per 5 s clip |
| Image → 3D prop | TRELLIS.2-4B | pod :8102 | installed, smoke test running |
| Text → concept image | to be picked in task 07 (a hosted NVIDIA image model, or SDXL-Turbo on the pod) | — | todo |
| Characters | the two VRM avatars from the old project (already toon-shaded) | `library/characters/` | to be copied |
| Starter props | the old project's 5 props plus a CC0 low-poly kit | `library/props/` | todo |

## 5. Unnatural movement: what we'll fix

- Turn on Kimodo's `post_processing`, which the old app never did, and compare
  foot sliding with and without it.
- Never loop Kimodo's padded still frames. Ask for the real beat length, and
  keep beats at 10 seconds or less.
- Join clips by matching pose and root position, not with a fixed 0.4 s crossfade.
- Check that Kimodo's text encoder loads correctly. It printed "MISSING"
  weights while loading.

## 6. Budget

The pod costs $0.60/hr, plus about $0.09/GB per month for the volume. Stop the pod
whenever no one is generating, log the hours in `docs/gpu-log.md`, and delete
the volume after the hackathon.

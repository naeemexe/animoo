# Plan

## 1. What we're building

The user types a scene. **Nemotron, working as an agent**, does the rest:

1. **Plan:** it breaks the prompt into a world layout (terrain, paths, water,
   zones), a list of props, the characters, and what each character does.
2. **Build:** it calls tools to make each part. Props come from the asset
   library, and any prop that's missing gets generated as a new 3D model.
3. **Animate:** it generates motion for each character and places them in the
   world.
4. **Check:** it renders a screenshot, looks at it with a Nemotron vision
   model, and fixes problems such as floating props or a character inside a house.

The look we're aiming for is the cel-shaded storybook village from the last
reference post. Most of that look comes from **the renderer** (toon shading,
soft outlines, warm grading, tilt-shift depth of field), not from the models.
That matters because the renderer can make generated assets and library assets
look like one set.

## 2. How it fits the track

| Track requirement | Where we meet it |
|---|---|
| Beyond a chatbot | The output is a 3D world with animated characters, not text. |
| Multi-step workflows | Plan → build → animate → check → fix, run by one agent loop. |
| Tool integration | `search_library`, `generate_asset`, `place`, `set_terrain`, `add_character`, `animate`, `render_and_check`. |
| Real-world applicability | Previs and storyboarding for small film teams, and fast world prototyping for indie games. |

## 3. Architecture

```
 browser (three.js)                       backend (Python, FastAPI)
 ─────────────────                        ──────────────────────────
 prompt box  ───────────────────────────▶ agent loop ──▶ Nemotron (build.nvidia.com API)
 stylized renderer  ◀── scene JSON ────── │   tools:
 timeline / playback                      │   search_library   → library/manifest.json
 screenshot  ──────────────────────────▶  │   generate_asset   → GPU box: text→image→3D
                                          │   set_terrain / place (pure code)
                                          │   animate          → GPU box: text→motion
                                          │   render_and_check → Nemotron vision model
                                          ▼
                                   library/  (every generated asset is cached here,
                                              so the demo never waits on a GPU)
```

- **Nemotron runs hosted**, through NVIDIA's OpenAI-compatible API at
  `integrate.api.nvidia.com/v1`, which has a free trial tier. That costs no GPU
  time. The exact model (a Nemotron 3 Super/Nano with tool calling, plus a
  Nemotron vision model for the check step) gets picked in Task 04 from what's
  live on build.nvidia.com.
- **The GPU box runs only the heavy models:** image→3D and text→motion. It's off
  when we aren't testing them.
- **API keys stay on the backend** and never reach the browser.

## 4. Model choices (to confirm in research tasks)

| Job | Lead option | Alternatives | Notes |
|---|---|---|---|
| Agent / planner | Nemotron (hosted) | — | Required by the track. |
| Vision check | Nemotron vision model (hosted) | — | Looks at screenshots. |
| Text → concept image | An image model hosted on build.nvidia.com, if one is available | FLUX / SDXL on the GPU box | Feeds image→3D. The prompt carries our style. |
| Image → 3D prop | **TRELLIS.2** (MIT, textured GLB) | Hunyuan3D 2.1 (restrictive license), SAM 3D Objects | Plan for about 24 GB VRAM. |
| Text → motion | **Kimodo** (NVIDIA, so it fits the track) | other open text-to-motion models | Needs about 17–24 GB VRAM. Fixing unnatural movement is its own task. |
| Starter props | A CC0 low-poly kit (for example Kenney or Quaternius) | — | The library starts with these, and generation fills the gaps. |

## 5. GPU budget: $60 of Brev credit

| Option | VRAM | $/hr | Hours for $60 | Fit |
|---|---|---|---|---|
| **RTX A6000 / A40** | 48 GB | 0.59 | ~100 | **Pick.** TRELLIS.2 and Kimodo both fit on one box. |
| L4 | 24 GB | 0.59 | ~100 | One model at a time, so models get swapped. |
| RTX 4090 | 24 GB | 0.89 | ~67 | Faster, but fewer hours. |
| A100 80 GB | 80 GB | 1.79 | ~33 | Not needed. |

**$60 is enough, so there's no need for RunPod.** With a deadline under 24 hours,
the box will run about 12–15 hours at most, which is about $7–9 on an A6000 or
A40 and $13–16 on an L40S. Even an A100 for the whole time would fit. The real
risks are time, not money: the card type being out of stock (pick the next
48 GB option on the list), and model weights taking time to download on first
start.

Rules:
- **Stop the instance whenever no one is actively testing generation.** The
  frontend, agent and renderer work runs on the laptop without a GPU.
- **Cache everything.** Each generated GLB or motion goes into `library/` with
  its prompt, so it's never paid for twice, and the final demo can run fully
  from the cache.
- **Log every session** in `docs/gpu-log.md` (date, hours, cost, what for).
  Stop and re-plan at $40 spent.
- RunPod is the fallback if Brev doesn't work out. The same server code runs there.

## 6. Milestones (deadline: 2026-11-08, 12:00 pm)

| # | Milestone | Tasks | GPU? |
|---|---|---|---|
| M1 | A storybook world from library assets | 01–02 | no |
| M2 | Nemotron builds that world from a prompt | 03–04 | no |
| M3 | Missing props get generated | 05, 07 | yes |
| M4 | Characters act in the world | 06, 08 | yes |
| M5 | Demo recorded from cache | 09 | no |

M1 and M2 alone already make a working demo, and each later milestone adds to
it. Work runs in two tracks at once: app on the laptop, GPU on Brev. See
`TASKS.md` for the schedule and the cut rule.

## 7. Open questions for you

- **Brev:** has the $60 code been redeemed?
- **Nemotron API key:** do you have a build.nvidia.com account?
- **HF token:** is the old token with Llama-3-8B-Instruct access still valid? Kimodo needs it.

## 8. Inspiration

- The cel-shaded village built from concept art (the target look).
- Polyfork: themed kits that share one palette and scale (our library idea).
- Strata: painted terrain tiles (terrain ideas).
- Wildward: water and reeds reacting to movement (stretch goal).
- SAM 3D: photo to 3D object (a candidate generator).

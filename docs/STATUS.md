# Status (hand-off)

Last updated 2026-11-08, 08:55. **Deadline: Sunday 2026-11-08, 12:00 pm.**
A new main session should read this first, then `TASKS.md`.

## What works

| Piece | State |
|---|---|
| Storybook renderer (toon, outlines, golden light, tilt-shift) | done (01) |
| Library: 46+ props (Kenney CC0 + generated), 2 VRMs, sample BVHs, `manifest.json` | done (04) |
| Characters: VRM retarget of Kimodo BVH, leg IK, smooth clip joins | done (05) |
| Movie page: agent log, set, timeline, director camera, play, WebM export | done on a **mock** script (09a); the real orchestrator is task 08 |
| Chat page: Mira talks (browser voice) and demonstrates Kimodo moves | done (10); replies from Nemotron when the limit allows |
| Prop generation: text → SANA image → TRELLIS.2 → normalized GLB in `library/` | done (07, 11) |
| Nemotron client + agent loop (JSON tool calls, SSE) | done (06) |
| Orchestrator + world agent (new prompt → new world and motion) | done (08), 2 Nemotron calls per movie (hosted, about 5 s in all, 08b), cached in `library/scripts/` |

## How to run

```bash
bash gpu/tunnel.sh                       # GPU servers → localhost:8101/8102/8103 (Brev box `framed-gpu`)
server/.venv/bin/uvicorn server.app:app --port 8000   # or the `animoo-server` launch config
open http://localhost:8000               # Movie | Chat
```

## Infrastructure

- **GPU: Brev A100 80 GB** (`framed-gpu`, $1.66/hr, paid from the $60 hackathon credit).
  It **can't be stopped, only deleted**, and it bills until then. **Delete it after the demo:**
  `brev delete framed-gpu`. On the box, manage servers with `bash /opt/app/serve.sh start|stop|status`,
  and rebuild everything with `bash /opt/app/setup.sh` (copy `gpu/` to `/opt/app` first).
  Details are in `docs/gpu-log.md`.
- **ElevenLabs:** key in `.env` (10k free credits, capped at 8000). New scenes get a 22 s ambience loop (~440 credits);
  ElevenLabs music is off unless `ELEVENLABS_MUSIC=1`, so the procedural pads play. Cached audio in `library/audio/` is free.
- **RunPod:** the old pod is stopped ($0/hr). Its volume `framed-models` still bills a little storage;
  delete the pod and the volume in the RunPod console when convenient.
- **LLM (Nemotron, per agent):** a build.nvidia.com key is in `.env` (`NVIDIA_API_KEY`; never commit or print it).
  The orchestrator and self-check use `nvidia/nemotron-3.5-super-vl-120b-a12b` (about 0.6 s for a short reply); the world,
  motion and director agents and Chat use `nvidia/nemotron-3.5-lightning-30b-a3b` (about 1.3 s; it reasons by default).
  The fallback chain is: hosted NVIDIA → self-hosted **Nemotron Nano 9B v2** on the Brev box (vLLM `:8104`,
  model `nemotron`, about 0.7 s, no limit; `bash /opt/app/serve.sh start llm`) → OpenCode free tier → mock.
  Per-agent routing is built (08b): `complete(..., agent=...)`, models from `LLM_MODEL_<AGENT>` in `.env`, hosted reasoning off
  (`LLM_THINK_<AGENT>=1` turns it on; slow). `LLM_BACKEND=off` forces the mock. `/health` → `config.llm` shows routes and recent calls. Regenerate the NVIDIA key after the hackathon (it was shared in chat).

## Next

Rounds 2–4 are done: action library + position control (22), look fixes (23, 28, 37), city/sea/park + interiors (24, 25),
story-driven looks and game-style skins with outfit/build (27, 35), edit mode, free camera and numbered path editor (18, 19, 29, 30),
collision rules (31), scene audio (32, procedural; ElevenLabs when keyed), leg IK + clip-join fixes (33), natural posture planning (34),
up to 5 cast + background NPCs (36).
`demo/` takes were recorded after round 3 (before 33–37); re-record with **Export WebM** on the Movie page if time allows (12c).
Left: **26 spoken dialogue** and ElevenLabs audio wait for `ELEVENLABS_API_KEY` in `.env`. Known gaps: `TASKS.md` → Found along the way.
**After the demo: `brev delete framed-gpu`** (it bills $1.66/hr until deleted).

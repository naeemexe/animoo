# Status (hand-off)

Last updated 2026-11-07, late evening. **Deadline: Sunday 2026-11-08, 12:00 pm.**
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
| Orchestrator + world agent (new prompt → new world and motion) | done (08), 2 Nemotron calls per movie, cached in `library/scripts/` |

## How to run

```bash
bash gpu/tunnel.sh                       # GPU servers → localhost:8101/8102/8103 (Brev box `framed-gpu`)
server/.venv/bin/uvicorn server.app:app --port 8000   # or the `animo-world-server` launch config
open http://localhost:8000               # Movie | Chat
```

## Infrastructure

- **GPU: Brev A100 80 GB** (`framed-gpu`, $1.66/hr, paid from the $60 hackathon credit).
  It **can't be stopped, only deleted**, and it bills until then. **Delete it after the demo:**
  `brev delete framed-gpu`. On the box, manage servers with `bash /opt/app/serve.sh start|stop|status`,
  and rebuild everything with `bash /opt/app/setup.sh` (copy `gpu/` to `/opt/app` first).
  Details are in `docs/gpu-log.md`.
- **RunPod:** the old pod is stopped ($0/hr). Its volume `framed-models` still bills a little storage;
  delete the pod and the volume in the RunPod console when convenient.
- **LLM (Nemotron, per agent):** a build.nvidia.com key is in `.env` (`NVIDIA_API_KEY`; never commit or print it).
  The orchestrator and self-check use `nvidia/nemotron-3.5-super-vl-120b-a12b` (about 0.6 s for a short reply); the world,
  motion and director agents and Chat use `nvidia/nemotron-3.5-lightning-30b-a3b` (about 1.3 s; it reasons by default).
  The fallback chain is: hosted NVIDIA → self-hosted **Nemotron Nano 9B v2** on the Brev box (vLLM `:8104`,
  model `nemotron`, about 0.7 s, no limit; `bash /opt/app/serve.sh start llm`) → OpenCode free tier → mock.
  Per-agent routing is **not built yet** (task 08b): today every call goes to the self-hosted Nano 9B (`.env`). Regenerate the NVIDIA key after the hackathon (it was shared in chat).

## Next

Follow the order in `TASKS.md`: 13 → 08b → 14 → 15 → 16 → 17 → **12 (record the demo before noon)** → 18 → 19 → 21.
User feedback lives in `FEEDBACK.md` (round 1 became tasks 13–21).
One session per task (`WORKFLOW.md`); Remote Control is on by default for new sessions.

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
| Orchestrator + world agent (new prompt → new world and motion) | **in progress (08)** |

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
- **LLM:** Nemotron through the local OpenCode CLI free tier (`LLM_BACKEND=opencode`,
  `opencode/nemotron-3.5-lightning-free`). It rate-limits after about 30 calls per ~30 min, so keep
  2–4 calls per movie and cache everything. To lift the limit, put a free build.nvidia.com key in
  `.env` as `NVIDIA_API_KEY` and set `LLM_BACKEND=nvidia`; no code changes are needed.

## Next

Follow the order in `TASKS.md`: 08 → 13 → 14 → 15 → 16 → 17 → **12 (record the demo before noon)** → 18 → 19 → 21.
User feedback lives in `FEEDBACK.md` (round 1 became tasks 13–21).
One session per task (`WORKFLOW.md`); Remote Control is on by default for new sessions.

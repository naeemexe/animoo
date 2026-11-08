# GPU log

## Current box: Brev (since 2026-11-07, about 9:30 pm)

| | |
|---|---|
| Provider | NVIDIA Brev, paid from the $60 hackathon credit (code redeemed 2026-11-07) |
| Instance | `framed-gpu` (id `urz6lbhpd`), MassedCompute **1x A100 SXM4 80 GB**, 160 GB RAM, 16 CPU, 1 TB SSD, **$1.66/hr** |
| Important | **It can't be stopped, only deleted, and it bills until then.** Delete it after the demo (`brev delete framed-gpu`). If the credit runs out, Brev deletes it. |
| SSH | `ssh framed-gpu` (the alias comes from `brev login` + `brev refresh`; user `shadeform`) |
| OS | Ubuntu 22.04, Python 3.10. `gpu/setup.sh` bootstraps it (CUDA 12.8, torch 2.8 cu128, g++-11, cmake) |
| Paths | the same as on RunPod: code in `/opt/app`, venvs in `/opt/venvs`, weights and logs in `/workspace` (a normal disk here) |
| Hugging Face | logged in as `naeemexe` (`HF_HOME=/workspace/hf`); access to Llama-3 and DINOv3 confirmed |
| Tunnel | `bash gpu/tunnel.sh` (defaults to `framed-gpu`) |

Checked on Brev: motion takes 4.1 s for a 4 s clip; text → image → 3D prop took 145 s on the first call
(models loading); GPU memory is 24 of 80 GB with all three servers idle.

## Previous box: RunPod (stopped 2026-11-07)

Pod `continental_coffee_goat` (A40) is **stopped** ($0/hr). Its global volume `framed-models` still
bills for storage; delete the pod and the volume in the RunPod console once Brev has proven itself.

Servers (run on the pod, bound to localhost; reach them with `bash gpu/tunnel.sh`):
- Motion server (Kimodo `kimodo-soma-rp-v1.2`) on **8101**. Starting it the first time
  downloads about 16 GB and takes about 6 minutes; later starts read from the volume.
  It uses about 16 GB of VRAM, and a 5 s clip takes about 4 s to generate.
- Asset server (TRELLIS.2-4B) on **8102**: about 47 s per prop at quality 512, about 220 s at
  1024_cascade. Background removal uses BiRefNet, not the gated RMBG-2.0.
- Image server (NVIDIA SANA-Sprint 1.6B, Apache-2.0; its Gemma-2-2B-IT text encoder is under
  the Gemma Terms of Use, and neither repo is gated) on **8103**: about 0.6 s per 1024² image on the GPU,
  about 1.7 s end to end, because the PNG is written to the volume. Weights are stored in fp8 and computed
  in bf16, so it holds 5.1 GiB and peaks at 6.7 GiB (7.6 GiB for the process). `/generate-prop` chains to
  TRELLIS.2 and takes about 45 s. Loading takes about 2 minutes.
- Start, stop or check all three with `bash /opt/app/serve.sh start|stop|status` (copy `gpu/` to `/opt/app`).
- Port 8001 belongs to the pod's own nginx, so don't use it.

Notes:
- `/workspace` is a FUSE object store (geesefs). It's fine for model weights, but
  slow for many small files, so put Python environments on the container disk
  and rebuild them with a setup script.
- System pip refuses to install packages (PEP 668). Use a venv, or
  `--break-system-packages` for single tools.
- Delete the `framed-models` volume after the hackathon, because it keeps
  billing for storage.

## Sessions

| Date | Hours | Cost | What |
|---|---|---|---|
| 2026-11-07 | ~0.6 | ~$0.35 | Pod created, GPU smoke test, volume attached, HF login |
| 2026-11-07 | ~1.0 | ~$0.60 | Kimodo installed and serving; TRELLIS.2 build started |
| 2026-11-07 | ~1.5 | ~$0.90 | TRELLIS.2 built and serving; Kimodo and TRELLIS.2 smoke tests pass |
| 2026-11-07 | ~0.35 | ~$0.21 | SANA-Sprint image server (:8103) installed; 5 sample images and one windmill GLB via /generate-prop |
| 2026-11-07 | ~0.05 | ~$0.03 | Task 11: one /generate-prop windmill (64 s) plus a cache hit. The pod was already running for other work and was left running. |
| 2026-11-07 | ~0.7 | ~$0.42 | Task 06a: tried Kimodo with the text encoder on the CPU (OOM at the 50 GB container RAM cap, then 2x slower), installed vLLM and downloaded Nemotron Nano 9B, then dropped it for hosted Nemotron. Kimodo is back on the GPU; motion (4.5 s), TRELLIS.2 and /generate-prop (68 s) checked. The pod was left running. |
| 2026-11-07 | ~0.7 | ~$1.20 | Brev A100: setup and smoke tests; RunPod stopped |
| 2026-11-08 | ~0.02 | ~$0.03 | Task 24: 3 TRELLIS.2 props (palm-tree 15 s, sand-pit 18 s (discarded), street-cafe 39 s). The box was already running and was left running. |

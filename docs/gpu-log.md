# GPU log

## Current box

| | |
|---|---|
| Provider | RunPod. Brev credits were waiting on team setup, so we started here. |
| Pod | `continental_coffee_goat` (id `0xmixn78r2549v`), A40 48 GB, $0.60/hr |
| SSH | `ssh root@194.68.245.46 -p 22149 -i ~/.ssh/id_ed25519`. **The port changes whenever the pod resets**, so check the RunPod console under Connect. |
| Image | `runpod/pytorch:1.5.0-cu1281-torch280-ubuntu2404` (torch 2.8, CUDA 12.8, Python 3.12) |
| Storage | Global volume `framed-models` mounted at `/workspace`, $0.09/GB per month plus IOPS. It survives pod resets and deletion. The 50 GB container disk at `/` is wiped on every reset. |
| Hugging Face | Logged in as `naeemexe`, with the token stored in `/workspace/hf`. **Always `export HF_HOME=/workspace/hf`** so the login and model weights persist. Access to gated Llama-3-8B-Instruct is confirmed. |

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

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

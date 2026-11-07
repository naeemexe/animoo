"""Motion server: text in, BVH out, using NVIDIA Kimodo.

Run on the GPU box (after `bash gpu/setup.sh kimodo`):

    HF_HOME=/workspace/hf /opt/venvs/kimodo/bin/uvicorn motion_server:app \
        --app-dir gpu --host 0.0.0.0 --port 8101

    GET  /health
    POST /generate-motion  {"prompt": str, "duration": s, "post_processing": bool,
                            "seed": int}  -> .bvh

Generated clips are cached in /workspace/cache/motion, keyed by every input,
so a repeated request costs no GPU time.
"""
import hashlib
import json
import os
import time

os.environ.setdefault("HF_HOME", "/workspace/hf")

import torch
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from kimodo import load_model
from kimodo.exports.bvh import save_motion_bvh
from kimodo.skeleton import SOMASkeleton30, global_rots_to_local_rots

MODEL_NAME = os.environ.get("KIMODO_MODEL", "Kimodo-SOMA-RP-v1.2")
CACHE = os.environ.get("MOTION_CACHE", "/workspace/cache/motion")
os.makedirs(CACHE, exist_ok=True)

app = FastAPI(title="Motion server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

device = "cuda:0"
t0 = time.time()
model, resolved = load_model(MODEL_NAME, device=device, default_family="Kimodo", return_resolved_name=True)
skeleton = model.skeleton
if isinstance(skeleton, SOMASkeleton30):
    skeleton = skeleton.somaskel77.to(device)
print(f"Loaded {resolved} in {time.time() - t0:.0f}s")


@app.get("/health")
def health():
    return {"status": "ok", "model": resolved, "gpu": torch.cuda.get_device_name(0)}


@app.post("/generate-motion")
def generate_motion(data: dict):
    prompt = data["prompt"]
    duration = float(data.get("duration", 5.0))
    post = bool(data.get("post_processing", True))
    seed = int(data.get("seed", 0))

    key = hashlib.sha1(json.dumps([resolved, prompt, duration, post, seed]).encode()).hexdigest()[:16]
    path = os.path.join(CACHE, f"{key}.bvh")
    if os.path.exists(path):
        return FileResponse(path, headers={"X-Cache": "hit"})

    torch.manual_seed(seed)
    t = time.time()
    out = model(
        [prompt],
        [int(duration * model.fps)],
        constraint_lst=[],
        num_denoising_steps=100,
        num_samples=1,
        multi_prompt=True,
        num_transition_frames=10,
        post_processing=post,
        return_numpy=True,
    )
    pos = torch.from_numpy(out["posed_joints"][0]).to(device)
    rot = torch.from_numpy(out["global_rot_mats"][0]).to(device)
    local = global_rots_to_local_rots(rot, skeleton)
    save_motion_bvh(path, local, pos[:, skeleton.root_idx, :], skeleton=skeleton, fps=model.fps)
    return FileResponse(path, headers={"X-Cache": "miss", "X-Gen-Seconds": f"{time.time() - t:.1f}"})

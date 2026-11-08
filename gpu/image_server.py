"""Image server: text in, storybook concept image out (NVIDIA SANA-Sprint),
plus a one-call text -> image -> TRELLIS.2 -> GLB chain.

Run on the GPU box (after `bash gpu/setup.sh image`), or `bash /opt/app/serve.sh start image`:

    HF_HOME=/workspace/hf /opt/venvs/image/bin/uvicorn image_server:app \
        --app-dir gpu --host 127.0.0.1 --port 8103

    GET  /health
    POST /generate-image  {"prompt": "a red wooden windmill", "seed": 0}  -> image/png
    POST /generate-prop   {"prompt": "a red wooden windmill", "seed": 0}  -> model/gltf-binary
    GET  /image/{key}.png  a cached concept image (key from the X-Image-Key header)

The house style (isolated object, plain light background, three-quarter view,
low-poly storybook) is added to every prompt unless "raw": true. Images are
cached in /workspace/cache/images by model, styled prompt, seed and steps, with
the prompt beside each PNG in a .json file. GLBs are cached by the asset server.
"""
import hashlib
import io
import json
import os
import threading
import time

os.environ.setdefault("HF_HOME", "/workspace/hf")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import httpx
import torch
from diffusers import SanaSprintPipeline
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

MODEL = os.environ.get("SANA_MODEL", "Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers")
ASSET_URL = os.environ.get("ASSET_URL", "http://127.0.0.1:8102")
CACHE = os.environ.get("IMAGE_CACHE", "/workspace/cache/images")
os.makedirs(CACHE, exist_ok=True)

STYLE = ("{prompt}, a single isolated object, centered, whole object in frame, "
         "three-quarter view from slightly above, low-poly storybook style, stylized 3D game asset, "
         "simple chunky shapes, flat soft colors, soft studio lighting, "
         "plain light grey background, no ground, no shadow, no text")

app = FastAPI(title="Image server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"],
                   allow_headers=["*"], expose_headers=["X-Cache", "X-Gen-Seconds", "X-Image-Key"])

t0 = time.time()
pipe = SanaSprintPipeline.from_pretrained(MODEL, torch_dtype=torch.bfloat16).to("cuda")
pipe.set_progress_bar_config(disable=True)
print(f"Loaded {MODEL} in {time.time() - t0:.0f}s, "
      f"{torch.cuda.memory_allocated() / 2**30:.1f} GiB on GPU")
gpu_lock = threading.Lock()  # one generation at a time; /health stays responsive


class ImageReq(BaseModel):
    prompt: str
    seed: int = 0
    steps: int = 2          # SANA-Sprint is distilled for 1-4 steps
    size: int = 1024
    raw: bool = False       # true: use the prompt as is, without the house style


class PropReq(ImageReq):
    quality: str = "512"    # TRELLIS.2: "512" (~47 s) | "1024_cascade" (~220 s)
    faces: int = 60000
    texture: int = 1024


def styled(req: ImageReq) -> str:
    return req.prompt.strip() if req.raw else STYLE.format(prompt=req.prompt.strip().rstrip("."))


def make_image(req: ImageReq) -> tuple[str, str, float]:
    """Return (cache key, png path, seconds spent generating; 0 for a cache hit)."""
    if not req.prompt.strip():
        raise HTTPException(400, "empty prompt")
    text = styled(req)
    key = hashlib.sha1(f"{MODEL}|{text}|{req.seed}|{req.steps}|{req.size}".encode()).hexdigest()[:16]
    path = os.path.join(CACHE, f"{key}.png")
    if os.path.exists(path):
        return key, path, 0.0
    with gpu_lock:
        t = time.time()
        img = pipe(prompt=text, num_inference_steps=req.steps, height=req.size, width=req.size,
                   generator=torch.Generator("cuda").manual_seed(req.seed)).images[0]
        dt = time.time() - t
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    with open(path, "wb") as f:  # plain write: the volume rejects chmod, so no shutil.copy
        f.write(buf.getvalue())
    with open(os.path.join(CACHE, f"{key}.json"), "w") as f:
        json.dump({"prompt": req.prompt, "styled": text, "seed": req.seed, "steps": req.steps,
                   "size": req.size, "model": MODEL, "seconds": round(dt, 2)}, f, indent=1)
    return key, path, dt


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL.split("/")[-1], "gpu": torch.cuda.get_device_name(0),
            "gpu_gib": round(torch.cuda.max_memory_allocated() / 2**30, 1)}


@app.post("/generate-image")
def generate_image(req: ImageReq):
    key, path, dt = make_image(req)
    return FileResponse(path, media_type="image/png", headers={
        "X-Cache": "hit" if dt == 0 else "miss", "X-Gen-Seconds": f"{dt:.2f}", "X-Image-Key": key})


@app.get("/image/{key}.png")
def get_image(key: str):
    path = os.path.join(CACHE, f"{os.path.basename(key)}.png")
    if not os.path.exists(path):
        raise HTTPException(404, "no such image")
    return FileResponse(path, media_type="image/png")


@app.post("/generate-prop")
def generate_prop(req: PropReq):
    t = time.time()
    key, path, _ = make_image(req)
    with open(path, "rb") as f:
        png = f.read()
    try:
        r = httpx.post(f"{ASSET_URL}/generate-asset", timeout=900,
                       files={"image": (f"{key}.png", png, "image/png")},
                       data={"seed": str(req.seed), "quality": req.quality,
                             "faces": str(req.faces), "texture": str(req.texture)})
    except httpx.HTTPError as e:
        raise HTTPException(502, f"asset server: {e}")
    if r.status_code != 200:
        raise HTTPException(502, f"asset server {r.status_code}: {r.text[:300]}")
    return Response(r.content, media_type="model/gltf-binary", headers={
        "X-Cache": r.headers.get("X-Cache", "?"), "X-Gen-Seconds": f"{time.time() - t:.1f}",
        "X-Image-Key": key})

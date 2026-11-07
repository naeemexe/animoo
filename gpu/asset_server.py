"""Asset server: image in, textured GLB out, using Microsoft TRELLIS.2.

Run on the GPU box (after `bash gpu/setup.sh trellis`):

    HF_HOME=/workspace/hf /opt/venvs/trellis/bin/uvicorn asset_server:app \
        --app-dir gpu --host 127.0.0.1 --port 8102

    GET  /health
    POST /generate-asset  multipart: image=<png/jpg>, faces, texture, seed, quality -> .glb

Results are cached in /workspace/cache/assets by image hash and settings.
The text -> concept image step lives in the app backend (task 07), not here.
"""
import hashlib
import io
import os
import sys
import time

os.environ.setdefault("HF_HOME", "/workspace/hf")
os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
sys.path.insert(0, os.environ.get("TRELLIS_DIR", "/opt/src/TRELLIS.2"))

import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image

import o_voxel
from trellis2.pipelines import Trellis2ImageTo3DPipeline
from trellis2.pipelines import rembg as _rembg

# The released pipeline removes backgrounds with briaai/RMBG-2.0, which is gated
# and non-commercial. Swap in the open BiRefNet (MIT) that the same class supports.
_birefnet_init = _rembg.BiRefNet.__init__
_rembg.BiRefNet.__init__ = lambda self, model_name=None: _birefnet_init(
    self, os.environ.get("REMBG_MODEL", "ZhengPeng7/BiRefNet"))

CACHE = os.environ.get("ASSET_CACHE", "/workspace/cache/assets")
os.makedirs(CACHE, exist_ok=True)

app = FastAPI(title="Asset server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])

t0 = time.time()
pipeline = Trellis2ImageTo3DPipeline.from_pretrained("microsoft/TRELLIS.2-4B")
pipeline.cuda()
print(f"Loaded TRELLIS.2-4B in {time.time() - t0:.0f}s")


@app.get("/health")
def health():
    return {"status": "ok", "model": "TRELLIS.2-4B", "gpu": torch.cuda.get_device_name(0)}


@app.post("/generate-asset")
async def generate_asset(
    image: UploadFile = File(...),
    faces: int = Form(60000),      # web-friendly polygon budget
    texture: int = Form(1024),
    seed: int = Form(0),
    quality: str = Form("512"),    # "512" (fast) | "1024_cascade" | "1536_cascade"
):
    raw = await image.read()
    key = hashlib.sha1(raw + f"|{faces}|{texture}|{seed}|{quality}".encode()).hexdigest()[:16]
    path = os.path.join(CACHE, f"{key}.glb")
    if os.path.exists(path):
        return FileResponse(path, media_type="model/gltf-binary", headers={"X-Cache": "hit"})

    t = time.time()
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    mesh = pipeline.run(img, seed=seed, pipeline_type=quality)[0]
    mesh.simplify(16777216)  # nvdiffrast limit
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=faces,
        texture_size=texture,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=False,
    )
    tmp = f"/tmp/{key}.glb"
    glb.export(tmp, extension_webp=True)
    with open(tmp, "rb") as src, open(path, "wb") as dst:  # volume rejects chmod; copy bytes
        dst.write(src.read())
    return FileResponse(path, media_type="model/gltf-binary",
                        headers={"X-Cache": "miss", "X-Gen-Seconds": f"{time.time() - t:.1f}"})

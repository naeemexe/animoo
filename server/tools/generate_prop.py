"""The world agent's `generate_prop` tool: a prop the library doesn't have.

    generate_prop(name="windmill", prompt="a red wooden windmill", size_m=7, category="buildings")

If `library/manifest.json` already has a prop with that id, it's returned at
once (a library hit). Otherwise the pod's image server makes a concept image
with SANA-Sprint and turns it into a GLB with TRELLIS.2 (about 45 s), and this
trims the ground slab, puts the pivot at bottom-center, scales it to `size_m`
tall, and saves GLB + concept PNG + prompt in `library/props/generated/` with
a manifest entry. Generation runs one at a time (the pod does one job at a time).

The pod is reached through `gpu/tunnel.sh` on localhost:8103 (`IMAGE_URL`);
if nothing listens there, the tunnel is started in the background.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from .glb import normalize_glb

ROOT = Path(__file__).resolve().parents[2]
LIBRARY = ROOT / "library"
MANIFEST = LIBRARY / "manifest.json"
OUT_DIR = LIBRARY / "props" / "generated"

# SANA ignores negatives, so ask for what we want: thin parts (lattice sails,
# railings) come out of TRELLIS.2 as spikes, so prompt for solid, chunky ones.
SHAPE_HINT = "solid chunky shapes, thick sturdy parts"
LICENSE = ("generated: concept image by NVIDIA SANA-Sprint 1.6B (Apache-2.0; its text encoder "
           "Gemma-2-2B-IT is under the Gemma Terms of Use), image to 3D by Microsoft TRELLIS.2-4B "
           "(MIT) with BiRefNet background removal (MIT)")
DEFAULT_SIZE_M = 2.0
STOP_WORDS = {"a", "an", "the", "of", "with", "and", "small", "big", "large", "tall"}

_lock = threading.Lock()


class GenerateError(RuntimeError):
    pass


def image_url() -> str:
    return os.getenv("IMAGE_URL", "http://localhost:8103").rstrip("/")


def slug(name: str) -> str:
    words = re.findall(r"[a-z0-9]+", name.lower())
    return "-".join(w for w in words if w not in {"a", "an", "the"})[:48] or "prop"


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text())


def find(manifest: dict, prop_id: str) -> dict | None:
    return next((p for p in manifest["props"] if p["id"] == prop_id), None)


def _port_open(url: str) -> bool:
    u = urlparse(url)
    try:
        with socket.create_connection((u.hostname, u.port or 80), timeout=1):
            return True
    except OSError:
        return False


def ensure_tunnel(url: str, wait_s: float = 20) -> None:
    """Start `bash gpu/tunnel.sh` in the background if the image server's port is closed."""
    if _port_open(url) or urlparse(url).hostname not in ("localhost", "127.0.0.1"):
        return
    subprocess.Popen(["bash", str(ROOT / "gpu" / "tunnel.sh")], cwd=ROOT, start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if _port_open(url):
            return
        time.sleep(0.5)
    raise GenerateError(f"the GPU tunnel didn't come up on {url} (is the pod running? see docs/gpu-log.md)")


def _post(url: str, body: dict, timeout: float) -> tuple[bytes, dict]:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        raise GenerateError(f"{url} returned {e.code}: {e.read()[:300].decode(errors='replace')}") from e
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise GenerateError(f"{url} failed: {e}") from e


LENGTHWISE = re.compile(r"\b(boat|canoe|raft|ship|cart|wagon|car|truck|bus|bridge|dock|pier|jetty|bench|log|fence|table)s?\b")


def fit_size(size: list[float], size_m: float, category: str | None = None, text: str = "") -> list[float]:
    """The real size of a generated prop from its normalized size (height = size_m).
    Long, low things (boats, carts, vehicles, docks, benches) take size_m as their longest
    side, so a "4 m fishing boat" is 4 m long, not 4 m tall and 10 m long. Anything else
    keeps its height but is never more than twice size_m (and 1.5 m) across."""
    w, h, d = size
    longest = max(w, h, d)
    if category in ("vehicles", "water") or LENGTHWISE.search(text.lower()):
        k = size_m / longest if longest else 1.0
    else:
        k = h and size_m / h
        k = min(k, max(2.0 * size_m, 1.5) / (max(w, d) * k)) * k if max(w, d) * k > max(2.0 * size_m, 1.5) else k
    return [round(v * k, 2) for v in size]


def _write_manifest(manifest: dict) -> None:
    tmp = MANIFEST.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    tmp.replace(MANIFEST)


def generate_prop(name: str, prompt: str | None = None, size_m: float | None = None,
                  category: str | None = None, seed: int = 0, trim_base: bool = True) -> dict:
    """Returns {"entry": manifest entry, "cached": bool, "seconds": float, ...}."""
    t0 = time.time()
    prop_id = slug(name)
    hit = find(load_manifest(), prop_id)
    if hit:
        return {"entry": hit, "cached": True, "seconds": round(time.time() - t0, 2)}

    with _lock:
        hit = find(load_manifest(), prop_id)  # generated while we waited for the lock
        if hit:
            return {"entry": hit, "cached": True, "seconds": round(time.time() - t0, 2)}

        prompt = (prompt or name).strip()
        size_m = float(size_m or DEFAULT_SIZE_M)
        text = f"{prompt}, {SHAPE_HINT}"
        base = image_url()
        ensure_tunnel(base)
        glb, headers = _post(f"{base}/generate-prop", {"prompt": text, "seed": seed}, timeout=900)
        key = headers.get("X-Image-Key") or headers.get("x-image-key")
        png = b""
        if key:
            try:
                with urllib.request.urlopen(f"{base}/image/{key}.png", timeout=60) as r:
                    png = r.read()
            except (urllib.error.URLError, TimeoutError):
                png = b""  # the GLB is what matters; the concept image is a nice-to-have

        glb, info = normalize_glb(glb, size_m, trim_base=trim_base)
        if not info.get("normalized"):
            info["size"] = [size_m, size_m, size_m]  # unknown footprint; the loader rescales by height
        else:  # the loader scales the GLB so its height is size[1]
            info["size"] = fit_size(info["size"], size_m, category, f"{name} {prompt}")

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{prop_id}.glb").write_bytes(glb)
        if png:
            (OUT_DIR / f"{prop_id}.png").write_bytes(png)
        record = {
            "id": prop_id, "name": name, "prompt": prompt, "sent_prompt": text, "seed": seed,
            "image_key": key, "size_m": size_m, "normalize": info,
            "pod_seconds": float(headers.get("X-Gen-Seconds") or headers.get("x-gen-seconds") or 0),
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        (OUT_DIR / f"{prop_id}.json").write_text(json.dumps(record, indent=1) + "\n")

        entry = {
            "id": prop_id,
            "file": f"props/generated/{prop_id}.glb",
            "category": category or "generated",
            "size": info["size"],
            "tags": sorted({w for w in re.findall(r"[a-z]+", f"{name} {prompt}".lower())
                            if w not in STOP_WORDS and len(w) > 2} | {"generated"}),
            "license": LICENSE,
            "source": "generated",
            "prompt": prompt,
        }
        if png:
            entry["thumbnail"] = f"props/generated/{prop_id}.png"
        manifest = load_manifest()
        manifest["props"].append(entry)
        _write_manifest(manifest)
        return {"entry": entry, "cached": False, "seconds": round(time.time() - t0, 1),
                "normalize": info}


# The tool as the world agent (task 08) will see it: an OpenAI-style schema.
TOOL = {
    "type": "function",
    "function": {
        "name": "generate_prop",
        "description": ("Make a 3D prop the library doesn't have (about 45 s on the GPU). Use only "
                        "after search_library finds nothing close. Returns its library id, which "
                        "is then placed like any library prop."),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "short id-like name, e.g. 'windmill'"},
                "prompt": {"type": "string", "description": "one object, e.g. 'a red wooden windmill'"},
                "size_m": {"type": "number", "description": "real-world size in meters: height, or length for boats, carts and vehicles"},
                "category": {"type": "string", "enum": ["buildings", "village", "nature", "vehicles", "water"]},
            },
            "required": ["name", "size_m"],
        },
    },
}

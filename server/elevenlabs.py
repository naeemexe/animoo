"""ElevenLabs client (task 32 scene audio; task 26 dialogue reuses `post`).

The key is read from ELEVENLABS_API_KEY (in .env) and never logged or sent to the
browser. Without it every call raises NoKey, and callers fall back (the Movie page
plays its procedural WebAudio instead).

Generated audio is cached in library/audio/ as <kind>-<hash>.mp3 with a .json next
to it holding the prompt and settings, so a replay never calls the API again.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "library" / "audio"
API = "https://api.elevenlabs.io"
FORMAT = "mp3_44100_128"

# kind → (endpoint, body for a prompt); the ambience loops seamlessly, the music is a short soft bed.
KINDS = {
    "ambience": ("/v1/sound-generation", lambda p: {"text": p, "model_id": "eleven_text_to_sound_v2", "loop": True,
                                                    "duration_seconds": 22, "prompt_influence": 0.35}),
    "music": ("/v1/music", lambda p: {"prompt": p, "model_id": "music_v1", "music_length_ms": 45000,
                                      "force_instrumental": True}),
}


class NoKey(RuntimeError):
    pass


class ElevenLabsError(RuntimeError):
    pass


def has_key() -> bool:
    return bool(os.getenv("ELEVENLABS_API_KEY"))


def post(path: str, body: dict, timeout: float = 120) -> bytes:
    """POST JSON to ElevenLabs, return the audio bytes."""
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        raise NoKey("no ELEVENLABS_API_KEY in .env")
    req = urllib.request.Request(f"{API}{path}?output_format={FORMAT}", data=json.dumps(body).encode(),
                                 headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode(errors="replace")
        raise ElevenLabsError(f"HTTP {e.code} from {path}: {detail}") from None
    except (urllib.error.URLError, OSError) as e:
        raise ElevenLabsError(f"{path} unreachable: {e}") from None
    if len(data) < 1000:
        raise ElevenLabsError(f"{path} returned {len(data)} bytes, not audio")
    return data


def cache_file(kind: str, prompt: str) -> Path:
    path, body = KINDS[kind]
    h = hashlib.sha1(json.dumps([path, body(prompt.strip())], sort_keys=True).encode()).hexdigest()[:12]
    return AUDIO / f"{kind}-{h}.mp3"


def scene_audio(kind: str, prompt: str) -> dict:
    """{url, cached, seconds} for one prompt: the cached mp3, else generated now (needs the key)."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {sorted(KINDS)}")
    f = cache_file(kind, prompt)
    url = f"/library/audio/{f.name}"
    if f.exists():
        return {"url": url, "cached": True, "seconds": 0}
    if not has_key():
        raise NoKey("no ELEVENLABS_API_KEY in .env")
    # Music costs far more credits than ambience; new beds only with ELEVENLABS_MUSIC=1
    # (otherwise the page keeps its procedural pads). Cached beds still play.
    if kind == "music" and os.getenv("ELEVENLABS_MUSIC") != "1":
        raise NoKey("ElevenLabs music is off (set ELEVENLABS_MUSIC=1 in .env)")
    path, body = KINDS[kind]
    t0 = time.perf_counter()
    data = post(path, body(prompt.strip()))
    sec = round(time.perf_counter() - t0, 1)
    AUDIO.mkdir(parents=True, exist_ok=True)
    f.write_bytes(data)
    f.with_suffix(".json").write_text(json.dumps({
        "kind": kind, "prompt": prompt.strip(), "endpoint": path, "body": {k: v for k, v in body(prompt).items() if k not in ("text", "prompt")},
        "bytes": len(data), "seconds": sec, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }, indent=1) + "\n")
    print(f"[elevenlabs] {kind}: {len(data) // 1024} KB in {sec}s → library/audio/{f.name}")
    return {"url": url, "cached": False, "seconds": sec}

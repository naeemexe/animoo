"""Animoo backend.

Run from the repo root:
    server/.venv/bin/uvicorn server.app:app --port 8000

It also serves `web/` at `/`, so one process is enough for the whole app.
Keys are read from `.env` into the environment and never sent to the browser.
"""

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import llm
from .agents import AGENTS, run as run_agent
from .chat import chat_reply
from .tools.actions import live_motion
from .tools.generate_prop import GenerateError, generate_prop

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="Animoo")

# The static web server (a different localhost port) calls this API too.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)


# Revalidate every file, so an edited ES module is never served stale from
# the browser's heuristic cache (unchanged files still come back as 304).
@app.middleware("http")
async def revalidate(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.get("/health")
def health() -> dict:
    # Report which settings exist, never their values.
    return {
        "ok": True,
        "service": "animoo",
        "config": {
            "llm": llm.info(),
            "nvidia_api_key": bool(os.getenv("NVIDIA_API_KEY")),
            "hf_token": bool(os.getenv("HF_TOKEN")),
            "elevenlabs_api_key": bool(os.getenv("ELEVENLABS_API_KEY")),
            "motion_url": os.getenv("MOTION_URL", "http://localhost:8101"),
            "asset_url": os.getenv("ASSET_URL", "http://localhost:8102"),
        },
    }


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


# The Chat page: {messages} -> {reply, demonstrate: null | {prompt, duration}, source}.
# Plain `def` so the blocking Nemotron call runs in the thread pool.
@app.post("/api/chat")
def chat(req: ChatRequest) -> dict:
    return chat_reply([m.model_dump() for m in req.messages])


# An agent run as server-sent events: one `data: {agent, kind, text, ms, data?}`
# per step, then `event: done` with {steps, seconds, llm_calls, llm_seconds}.
# EventSource can only GET, so the task is a query parameter. The generator is
# sync, so Starlette runs each blocking step in the thread pool.
@app.get("/api/agents/{name}/run")
def agent_run(name: str, task: str = "") -> StreamingResponse:
    agent = AGENTS.get(name)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"no agent {name!r}; agents: {sorted(AGENTS)}")
    if not task.strip():
        from .agents.test_agent import DEFAULT_TASK
        task = DEFAULT_TASK if name == "test" else ""
    if not task.strip():
        raise HTTPException(status_code=400, detail="task is empty")

    def events():
        t0, n = time.perf_counter(), 0
        started = time.time()
        yield f": {name} agent started\n\n"
        for step in run_agent(agent, task):
            n += 1
            yield f"data: {json.dumps(step, ensure_ascii=False)}\n\n"
        calls = [c for c in list(llm.CALLS) if c["at"] >= started]
        summary = {"steps": n, "seconds": round(time.perf_counter() - t0, 2), "llm_calls": len(calls),
                   "llm_seconds": [c["seconds"] for c in calls], "backend": llm.backend(),
                   "model": ", ".join(sorted({c["model"] for c in calls if c["ok"]})) or "none"}
        yield f"event: done\ndata: {json.dumps(summary)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# The Movie page's planning run (orchestrator + world agents, server/agents/movie.py)
# as server-sent events: `data:` steps, then `event: script` with {script, source,
# llm_calls} (script is null when the page should play its mock), then `event: done`.
# Cached per scene text in library/scripts/; `fresh=1` asks Nemotron again.
@app.get("/api/movie/plan")
def movie_plan(scene: str, fresh: bool = False) -> StreamingResponse:
    from .agents.movie import plan_movie
    if not scene.strip():
        raise HTTPException(status_code=400, detail="scene is empty")

    def events():
        t0 = time.perf_counter()
        yield ": planning\n\n"
        try:
            for ev in plan_movie(scene, fresh=fresh):
                if "step" in ev:
                    yield f"data: {json.dumps(ev['step'], ensure_ascii=False)}\n\n"
                else:
                    yield f"event: script\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as err:  # never leave the page hanging: it falls back to the mock
            import traceback
            traceback.print_exc()
            step = {"agent": "orchestrator", "kind": "error", "text": f"planning crashed: {type(err).__name__}: {err}", "ms": 0}
            yield f"data: {json.dumps(step)}\n\n"
            yield f"event: script\ndata: {json.dumps({'script': None, 'source': 'mock', 'llm_calls': 0})}\n\n"
        yield f"event: done\ndata: {json.dumps({'seconds': round(time.perf_counter() - t0, 2)})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ScriptEdit(BaseModel):
    scene: str
    props: list[dict]
    camera_paths: list[dict] | None = None  # task 19; None keeps the saved ones
    walk_paths: list[dict] | None = None  # task 30: [{beat, cast, points: [[x, z], …]}]; None keeps the saved ones


def _bad_path(cp: dict) -> bool:
    num = lambda v: isinstance(v, (int, float))
    vec = lambda v: isinstance(v, list) and len(v) == 3 and all(num(x) for x in v)
    keys = cp.get("keys")
    return not (num(cp.get("start")) and num(cp.get("end")) and cp["start"] < cp["end"] and isinstance(keys, list)
                and all(isinstance(k, dict) and num(k.get("t")) and vec(k.get("pos")) and vec(k.get("look")) for k in keys))


# Edit mode on the Movie page (task 18): the edited props go into the scene's
# cache file in library/scripts/, so the next replay of the scene uses them.
@app.post("/api/movie/revise")
def movie_revise(body: dict) -> dict:
    """A follow-up request on the current film: {base, request} → {scene} to play (a cached replay)."""
    from .agents.movie import revise_movie
    base, request = str(body.get("base") or ""), str(body.get("request") or "")
    if not base.strip() or not request.strip():
        raise HTTPException(status_code=400, detail="base and request are required")
    try:
        scene, calls, how = revise_movie(base, request)
    except ValueError as err:
        raise HTTPException(status_code=409, detail=str(err))
    # Only the time of day or weather changed: the page relights the film in place (no rebuild).
    from .agents.movie import load_cached, repair_plan
    env = None
    try:
        old_p, _ = repair_plan(load_cached(base)["plan"], base)
        new_p, _ = repair_plan(load_cached(scene)["plan"], scene)
        rest = lambda p: {k: v for k, v in p.items() if k not in ("time_of_day", "weather", "audio")}
        if rest(old_p) == rest(new_p):
            env = {"terrain": {"time_of_day": new_p["time_of_day"], "weather": new_p["weather"]}, "audio": new_p.get("audio")}
    except (TypeError, KeyError, ValueError):
        pass
    return {"scene": scene, "llm_calls": calls, "how": how, "env": env}


@app.post("/api/movie/script")
def movie_script_save(req: ScriptEdit) -> dict:
    from .agents.movie import save_edits
    for p in req.props:
        pos = p.get("position")
        if not isinstance(p.get("key"), str) or not isinstance(p.get("library"), str) \
                or not (isinstance(pos, list) and len(pos) == 2 and all(isinstance(v, (int, float)) for v in pos)):
            raise HTTPException(status_code=400, detail=f"bad prop: {p}")
    for cp in req.camera_paths or []:
        if _bad_path(cp):
            raise HTTPException(status_code=400, detail=f"bad camera path: {cp}")
    num = lambda v: isinstance(v, (int, float))
    for w in req.walk_paths or []:
        pts = w.get("points")
        if not isinstance(w.get("beat"), str) or not isinstance(pts, list) or not pts \
                or not all(isinstance(q, list) and len(q) == 2 and all(num(v) for v in q) for q in pts):
            raise HTTPException(status_code=400, detail=f"bad character path: {w}")
    try:
        path = save_edits(req.scene, req.props, req.camera_paths, req.walk_paths)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"file": path.name, "props": len(req.props), "camera_paths": len(req.camera_paths or []),
            "walk_paths": len(req.walk_paths or [])}


class AudioRequest(BaseModel):
    ambience: str | None = None  # the script's audio.ambience.prompt
    music: str | None = None  # the script's audio.music.prompt


# Scene audio files (task 32): {ambience?, music?} prompts -> per kind {url, cached, seconds}
# or null with the reason. Cached mp3s in library/audio/ come back without a key; new ones
# need ELEVENLABS_API_KEY. A null tells the page to keep its procedural WebAudio.
@app.post("/api/movie/audio")
def movie_audio(req: AudioRequest) -> dict:
    from . import elevenlabs
    out = {"key": elevenlabs.has_key(), "errors": {}}
    for kind in ("ambience", "music"):
        prompt = (getattr(req, kind) or "").strip()
        out[kind] = None
        if not prompt:
            continue
        try:
            out[kind] = elevenlabs.scene_audio(kind, prompt)
        except elevenlabs.NoKey as e:
            out["errors"][kind] = str(e)
        except elevenlabs.ElevenLabsError as e:
            print(f"[elevenlabs] {kind} failed: {e}")
            out["errors"][kind] = str(e)[:200]
    return out


class SpeechRequest(BaseModel):
    text: str


# The Chat character's voice (ElevenLabs): one sentence -> {url, cached, seconds}, cached in
# library/audio/. 503 without a key or when ElevenLabs fails: the page falls back to the browser voice.
@app.post("/api/chat/speech")
def chat_speech(req: SpeechRequest) -> dict:
    from . import elevenlabs
    try:
        return elevenlabs.speech(req.text[:600])
    except (elevenlabs.NoKey, elevenlabs.ElevenLabsError, ValueError) as e:
        print(f"[elevenlabs] speech failed: {e}")
        raise HTTPException(503, str(e)[:200])


class PropRequest(BaseModel):
    name: str
    prompt: str | None = None
    size_m: float | None = None
    category: str | None = None
    seed: int = 0


# The world agent's generate_prop tool over HTTP: {name, prompt?, size_m?, category?}
# -> {entry, cached, seconds}. A library hit returns at once; a new prop takes
# about 45 s on the pod. Plain `def`, so the wait runs in the thread pool.
@app.post("/api/props/generate")
def props_generate(req: PropRequest) -> dict:
    try:
        return generate_prop(req.name, req.prompt, req.size_m, req.category, seed=req.seed)
    except GenerateError as e:
        raise HTTPException(status_code=503, detail=str(e))


class MotionRequest(BaseModel):
    prompt: str
    duration: float = 5
    seed: int = 0


# A move outside the action library (task 22): Kimodo once, then cached in
# library/motions/live/ with its prompt. Returns the BVH text; X-Cache says hit/miss.
@app.post("/api/motion")
def motion_live(req: MotionRequest):
    from fastapi.responses import PlainTextResponse
    try:
        text, hit = live_motion(req.prompt, req.duration, req.seed)
    except OSError as e:
        raise HTTPException(status_code=503, detail=f"Kimodo unreachable: {e}")
    return PlainTextResponse(text, headers={"X-Cache": "hit" if hit else "miss"})


# The asset library (props, characters, motions, manifest.json).
app.mount("/library", StaticFiles(directory=ROOT / "library"), name="library")
# Mounted last so API routes win.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")

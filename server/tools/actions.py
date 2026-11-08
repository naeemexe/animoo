"""The action library (task 22): a fixed set of standard clips, generated once
with Kimodo and cached in library/motions/actions/ with their prompts, like a
game's animation set. The scene controls where a character is and which way it
faces; the clips only supply the body's motion.

    python -m server.tools.actions          # generate the missing ones (Kimodo on :8101)
    python -m server.tools.actions --force  # regenerate all

Each action has a `root` mode that the director (web/js/movie/director.js) reads:
  path    locomotion: the clip's forward travel is warped onto a planned path
  pinned  in place: the clip's own drift and turning are removed
  free    keep the clip's root motion (sitting, which steps back onto the seat)

`cut` keeps part of a longer clip, found from the hips height:
  until_seated  from the start until 0.6 s after the hips reach the low plateau
  seated        the low plateau only (a seated idle or seated talk)
  rise          from just before the hips start rising to the end (standing up)
`time_scale` (> 1 slows down) is applied in the browser, on the retargeted clip.

Moves that aren't in the library go to Kimodo live through POST /api/motion,
which saves them in library/motions/live/ with their prompt, so they're
generated only once too.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ACTIONS_DIR = ROOT / "library" / "motions" / "actions"
LIVE_DIR = ROOT / "library" / "motions" / "live"
MOTION_URL = os.environ.get("MOTION_URL", "http://localhost:8101")

# id: (prompt, seconds to generate, root, extra)
ACTIONS: dict[str, dict] = {
    "idle":         {"prompt": "A person stands still, breathing calmly and looking around.", "duration": 6, "root": "pinned"},
    "walk_steps":   {"prompt": "A person takes a few steps forward and stops.", "duration": 2.5, "root": "path"},
    "walk_short":   {"prompt": "A person walks forward.", "duration": 3.5, "root": "path"},
    "walk":         {"prompt": "A person walks forward.", "duration": 6, "root": "path"},
    "walk_long":    {"prompt": "A person walks forward.", "duration": 10, "root": "path"},
    "run":          {"prompt": "A person runs forward.", "duration": 4, "root": "path"},
    "run_long":     {"prompt": "A person runs forward.", "duration": 8, "root": "path"},
    "crouch_walk":  {"prompt": "A person sneaks forward in a low crouch.", "duration": 6, "root": "path"},
    "jump":         {"prompt": "A person jumps up in place.", "duration": 2.5, "root": "pinned"},
    "talk":         {"prompt": "A person stands and talks, gesturing with both hands.", "duration": 5, "root": "pinned"},
    "wave":         {"prompt": "A person waves hello with their right hand.", "duration": 3, "root": "pinned"},
    "point":        {"prompt": "A person points straight ahead with their right arm.", "duration": 3, "root": "pinned"},
    "laugh":        {"prompt": "A person laughs heartily.", "duration": 3, "root": "pinned"},
    "stretch":      {"prompt": "A person stretches their arms up over their head.", "duration": 4, "root": "pinned"},
    "pick_up":      {"prompt": "A person bends down and picks something up from the ground.", "duration": 3.5, "root": "pinned"},
    "dig":          {"prompt": "A person digs the ground with a shovel.", "duration": 5, "root": "pinned"},
    "hammer":       {"prompt": "A person hammers a nail, building something.", "duration": 5, "root": "pinned"},
    "punch":        {"prompt": "A person punches forward with their right fist.", "duration": 2.5, "root": "pinned"},
    "kick":         {"prompt": "A person kicks forward with their right leg.", "duration": 2.5, "root": "pinned"},
    "push":         {"prompt": "A person pushes a heavy object in front of them with both hands.", "duration": 4, "root": "pinned"},
    "dance":        {"prompt": "A person dances happily.", "duration": 6, "root": "free"},
    "sit_bench":    {"prompt": "A person sits down on a bench and rests.", "duration": 5, "root": "free", "cut": "until_seated"},
    "sit_bench_idle": {"prompt": "A person sits down on a bench and rests.", "duration": 8, "root": "pinned", "cut": "seated"},
    "sit_bench_talk": {"prompt": "A person sits down on a bench and talks, gesturing with their hands.", "duration": 8, "root": "pinned", "cut": "seated"},
    "stand_up_chair": {"prompt": "A person sits on a chair, then slowly stands up.", "duration": 6, "root": "free", "cut": "rise", "min_s": 1.8},
    "sit_ground":   {"prompt": "A person sits down on the ground.", "duration": 4, "root": "free", "cut": "until_seated"},
    "sit_ground_idle": {"prompt": "A person sits down on the ground and rests.", "duration": 8, "root": "pinned", "cut": "seated"},
    "stand_up_ground": {"prompt": "A person sits on the ground, then slowly gets up and stands.", "duration": 7, "root": "free", "cut": "rise", "min_s": 2.0},
}

# Seated poses: what a beat after a sit maps to, unless it stands up.
SEATED = {"bench": {"idle": "sit_bench_idle", "talk": "sit_bench_talk", "laugh": "sit_bench_talk", "wave": "sit_bench_talk"},
          "ground": {"idle": "sit_ground_idle", "talk": "sit_ground_idle", "laugh": "sit_ground_idle", "wave": "sit_ground_idle"}}

# Words → action, first match wins. Applied to "action" label + prompt.
RULES: list[tuple[str, str]] = [
    (r"\b(stands? up|gets? up|rises?|getting up|standing up)\b", "stand_up"),
    (r"\b(sits?|sitting|seated|sat)\b", "sit"),
    (r"\b(sneak|sneaks|crouch\w*|creeps?|tiptoes?)\b", "crouch_walk"),
    (r"\b(runs?|running|jogs?|sprints?|dash\w*|chases?|hurr\w+|races?|flees?|runs off)\b", "run"),
    (r"\b(walks?|walking|strolls?|steps?|wanders?|heads?|goes|approach\w*|marches|returns?|limps?|moves?)\b", "walk"),
    (r"\b(waves?|waving|greets?|hello|hi)\b", "wave"),
    (r"\b(points?|pointing|shows the way)\b", "point"),
    (r"\b(laughs?|laughing|giggles?|chuckles?)\b", "laugh"),
    (r"\b(talks?|talking|tells?|speaks?|says|chats?|explains?|asks?|shouts?|calls?|story|gestur\w*)\b", "talk"),
    (r"\b(jumps?|jumping|hops?|leaps?)\b", "jump"),
    (r"\b(stretch\w*|yawns?)\b", "stretch"),
    (r"\b(picks? up|grabs?|lifts?|gathers?|collects?|draws water|takes)\b", "pick_up"),
    (r"\b(digs?|digging|shovels?|plants?)\b", "dig"),
    (r"\b(hammers?|builds?|building|fix\w*|repairs?|nails?)\b", "hammer"),
    (r"\b(punch\w*|hits?|strikes?)\b", "punch"),
    (r"\b(kicks?|kicking)\b", "kick"),
    (r"\b(push\w*|shoves?)\b", "push"),
    (r"\b(danc\w*)\b", "dance"),
    (r"\b(idles?|stands?|waits?|watch\w*|looks?|rests?|listens?|thinks?|breathes?|stays?|smiles?|nods?)\b", "idle"),
]


def action_for(text: str, seated: str | None = None, ground: bool = False) -> str | None:
    """The library action for a beat (its label + prompt), or None for a move
    the library doesn't have. `seated` is "bench" or "ground" when the
    character is sitting before this beat."""
    t = text.lower()
    hit = next((a for pat, a in RULES if re.search(pat, t)), None)
    if hit == "stand_up":
        return "stand_up_ground" if (seated == "ground" or (seated is None and ground)) else "stand_up_chair"
    if hit == "sit":
        if seated:
            return SEATED[seated]["idle"]
        return "sit_ground" if ground else "sit_bench"
    if seated and hit in (None, "idle", "talk", "laugh", "wave"):
        return SEATED[seated].get(hit or "idle")
    if hit in ("walk", "run"):
        return hit  # the director picks walk_short / walk / walk_long by distance
    return hit


GROUND_WORDS = re.compile(r"\b(ground|grass|floor|sand|blanket|lawn|meadow|knees)\b", re.I)


# ---- BVH cutting ----------------------------------------------------------

def _split(text: str) -> tuple[list[str], list[str], float]:
    head, motion = text.split("MOTION", 1)
    lines = [l for l in motion.strip().splitlines()]
    ft = float(lines[1].split(":")[1])
    return [head + "MOTION"], [l for l in lines[2:] if l.strip()], ft


def _hips_y(frames: list[str]) -> list[float]:
    # Root (6 channels) then Hips (6 channels): Hips Yposition is column 7, plus the root's Y.
    out = []
    for l in frames:
        c = l.split()
        out.append(float(c[1]) + float(c[7]))
    return out


def cut_bvh(text: str, mode: str) -> tuple[str, dict]:
    head, frames, ft = _split(text)
    y = _hips_y(frames)
    fps = 1 / ft
    h0, hm = max(y), min(y)  # standing and seated hips height (a clip may start seated)
    thr = hm + 0.2 * (h0 - hm)
    low = [i for i, v in enumerate(y) if v < thr]
    if not low or h0 - hm < 15:  # cm: never sat
        return text, {"cut": mode, "warning": "no seated part found, kept whole"}
    a, b = low[0], low[-1]
    # Where standing up really starts (hips leave the seat) and ends (95 % up).
    rise0 = max(i for i in range(b + 1) if y[i] < hm + 0.05 * (h0 - hm))
    rise1 = next((i for i in range(b, len(y)) if y[i] > hm + 0.95 * (h0 - hm)), len(y) - 1)
    if mode == "until_seated":
        s, e = 0, min(len(frames), a + int(0.6 * fps))
    elif mode == "seated":
        s, e = a + int(0.3 * fps), b
    elif mode == "rise":
        s, e = max(0, rise0 - int(0.4 * fps)), min(len(frames), rise1 + int(1.0 * fps))
    else:
        raise ValueError(mode)
    kept = frames[s:e]
    out = f"{head[0]}\nFrames: {len(kept)}\nFrame Time: {ft}\n" + "\n".join(kept) + "\n"
    info = {"cut": mode, "from_frame": s, "to_frame": e, "seconds": round(len(kept) / fps, 2)}
    if mode == "rise":
        info["rise_s"] = round((rise1 - rise0) / fps, 2)
    return out, info


# ---- Kimodo ---------------------------------------------------------------

def kimodo(prompt: str, duration: float, seed: int = 0, timeout: float = 180) -> str:
    body = json.dumps({"prompt": prompt, "duration": duration, "post_processing": True, "seed": seed}).encode()
    req = urllib.request.Request(f"{MOTION_URL}/generate-motion", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def generate(force: bool = False) -> dict:
    ACTIONS_DIR.mkdir(parents=True, exist_ok=True)
    index = {}
    raw: dict[tuple, str] = {}
    for aid, spec in ACTIONS.items():
        path = ACTIONS_DIR / f"{aid}.bvh"
        meta_path = ACTIONS_DIR / f"{aid}.json"
        if path.exists() and meta_path.exists() and not force:
            index[aid] = json.loads(meta_path.read_text())
            continue
        key = (spec["prompt"], spec["duration"])
        t0 = time.time()
        if key not in raw:
            raw[key] = kimodo(spec["prompt"], spec["duration"])
        text, info = raw[key], {}
        if spec.get("cut"):
            text, info = cut_bvh(text, spec["cut"])
        if spec.get("min_s") and info.get("rise_s"):
            info["time_scale"] = round(max(1.0, spec["min_s"] / info["rise_s"]), 2)
        path.write_text(text)
        meta = {"id": aid, "file": f"motions/actions/{aid}.bvh", **{k: v for k, v in spec.items()},
                "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "kimodo_seconds": round(time.time() - t0, 1),
                "post_processing": True, "seed": 0, **info}
        meta_path.write_text(json.dumps(meta, indent=1))
        index[aid] = meta
        print(f"{aid:16s} {meta['kimodo_seconds']:5.1f} s  {info or ''}", flush=True)
    (ACTIONS_DIR / "index.json").write_text(json.dumps(index, indent=1))
    return index


def live_motion(prompt: str, duration: float, seed: int = 0) -> tuple[str, bool]:
    """A move outside the library: Kimodo once, then library/motions/live/."""
    LIVE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{prompt}|{duration:.2f}|{seed}".encode()).hexdigest()[:10]
    slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")[:40]
    path = LIVE_DIR / f"{slug}-{key}.bvh"
    if path.exists():
        return path.read_text(), True
    text = kimodo(prompt, duration, seed)
    path.write_text(text)
    path.with_suffix(".json").write_text(json.dumps({"prompt": prompt, "duration": duration, "seed": seed,
                                                     "post_processing": True, "generated": time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=1))
    return text, False


if __name__ == "__main__":
    generate(force="--force" in sys.argv)

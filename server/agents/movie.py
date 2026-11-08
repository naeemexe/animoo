"""The Movie page's planning agents: orchestrator and world, then layout code.

    for event in plan_movie(scene): ...   # {"step": {...}} ... then {"script": ..., "source": ...}

Budget: the OpenCode free tier stops after about 30 Nemotron calls, so a movie
costs **two** calls (plus at most one re-ask each):

1. Orchestrator (one call): the scene text → a *story plan*: title, time of
   day, named places, cast, beats in story order (who does what, a Kimodo
   prompt "A person ...", where they go, who they face, what they wait for)
   and shots. No coordinates: small models are bad at geometry.
2. World (one call): for each place, `search_library` results are gathered
   first (plain code, logged as the world agent's tool calls), and Nemotron
   picks one library prop per place or asks `generate_prop` for at most two
   key props the library lacks, plus mood decor.

Then `layout()` (code, no LLM) turns plan + choices into the scene script of
`web/js/movie/script.js`: places along a walking route, the pond, stand and
seat slots, beat start times from the sync links, walk durations fitted to the
distances, idle fillers for waits, shots, decor scattered without overlaps.

The raw Nemotron answers are cached in `library/scripts/` keyed by the scene
text, so re-running a scene costs no calls and layout changes still apply. If
Nemotron fails or is rate-limited, the closest cached scene is used, else the
page's mock (the fisherman), and the log says so.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .. import llm
from ..tools.generate_prop import load_manifest, slug

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "library" / "scripts"
RAD = math.pi / 180
MAX_BEAT = 10.0
ISLAND = 15.0  # stay inside this radius (the island is 18 m)
TIMES = ["sunrise", "day", "golden", "dusk"]
CHARACTERS = ["avatar_male", "avatar_female"]
GEN_CATEGORIES = ["buildings", "village", "nature", "vehicles", "water"]
MAX_GENERATE = 2
# The VRMs' own standing heights (measured on the Movie page) and the heights we want:
# the male model is 2.0 m tall, the female 1.54 m.
HEIGHT = {"avatar_male": (2.01, 1.78), "avatar_female": (1.54, 1.66)}
KID = 0.8
SEATS = {"bench", "stump"}
SIT_BACK = 0.45  # Kimodo's sit-down clips step back about this far: stand that far in front of the seat  # props a character sits on (others: sit or stand beside them)


# ---- search_library ----------------------------------------------------------

def _words(text: str) -> set[str]:
    return {w.rstrip("s") if len(w) > 3 else w for w in re.findall(r"[a-z]+", text.lower())}


STOP = {"a", "an", "the", "of", "with", "and", "small", "big", "old", "little", "wooden", "to", "on", "in", "at", "for", "by"}


def search_library(query: str, limit: int = 5, manifest: dict | None = None, key: str = "", use: str = "") -> list[dict]:
    """Props whose id, tags or category share words with the query, best first.
    Words of `key` (the place's short name) count double; `use="sit"` favors seats."""
    manifest = manifest or load_manifest()
    q = _words(query) - STOP
    k = _words(key.replace("-", " ")) - STOP
    scored = []
    for p in manifest["props"]:
        ids, tags = _words(p["id"].replace("-", " ")), _words(" ".join(p.get("tags", [])))
        score = 3 * len(q & ids) + 2 * len(q & tags) + len(q & _words(p.get("category", "")))
        score += 3 * len(k & (ids | tags)) + (3 if use == "sit" and "seat" in tags else 0)
        if score:
            scored.append((score, p))
    scored.sort(key=lambda sp: -sp[0])
    return [{"id": p["id"], "height_m": p["size"][1], "tags": p.get("tags", [])} for _, p in scored[:limit]]


# ---- the two Nemotron calls ------------------------------------------------------

PLAN_EXAMPLE = {
    "title": "Ducks at the pond",
    "thoughts": ["Two characters: a girl and her grandpa. Afternoon light, a pond.",
                 "Places: their cottage, a bench, the jetty at the pond.",
                 "Grandpa walks to the bench and sits; the girl skips to the pond, feeds the ducks and waves at him once he sits."],
    "time_of_day": "golden",
    "water": True,
    "places": [
        {"key": "cottage", "what": "a small cottage", "use": "stand"},
        {"key": "bench", "what": "a wooden park bench", "use": "sit"},
        {"key": "jetty", "what": "a little wooden jetty at the pond", "use": "water"},
    ],
    "cast": [
        {"id": "girl", "name": "Girl", "character": "avatar_female", "kid": True, "starts_at": "cottage"},
        {"id": "grandpa", "name": "Grandpa", "character": "avatar_male", "kid": False, "starts_at": "cottage"},
    ],
    "beats": [
        {"id": "b1", "cast": "grandpa", "action": "walks to the bench", "prompt": "A person walks forward slowly.", "duration": 6, "move_to": "bench"},
        {"id": "b2", "cast": "girl", "action": "skips to the pond", "prompt": "A person skips forward happily.", "duration": 5, "move_to": "jetty"},
        {"id": "b3", "cast": "grandpa", "action": "sits down", "prompt": "A person sits down on a bench and rests.", "duration": 5},
        {"id": "b4", "cast": "girl", "action": "feeds the ducks", "prompt": "A person crouches down and tosses food with one hand.", "duration": 5, "face": "jetty"},
        {"id": "b5", "cast": "girl", "action": "waves at grandpa", "prompt": "A person waves hello with their right hand.", "duration": 3, "face": "grandpa", "after": "b3"},
    ],
    "shots": [
        {"framing": "wide", "subject": ["grandpa", "girl"], "until": "b2"},
        {"framing": "medium", "subject": "girl", "until": "b4"},
        {"framing": "medium", "subject": ["girl", "grandpa"], "until": "b5"},
    ],
}

PLAN_SCHEMA = {
    "type": "object",
    "required": ["title", "time_of_day", "places", "cast", "beats"],
    "properties": {
        "title": {"type": "string"},
        "thoughts": {"type": "array", "items": {"type": "string"}},
        "time_of_day": {"type": "string"},
        "water": {"type": "boolean"},
        "places": {"type": "array", "items": {"type": "object", "required": ["key", "what"],
                   "properties": {"key": {"type": "string"}, "what": {"type": "string"}, "use": {"type": "string"}}}},
        "cast": {"type": "array", "items": {"type": "object", "required": ["id"],
                 "properties": {"id": {"type": "string"}, "name": {"type": "string"}, "character": {"type": "string"}}}},
        "beats": {"type": "array", "items": {"type": "object", "required": ["cast", "prompt"],
                  "properties": {"cast": {"type": "string"}, "prompt": {"type": "string"}}}},
        "shots": {"type": "array"},
    },
}

ORCHESTRATOR_ROLE = """You are the orchestrator of a team of agents that turns a scene description into a short
animated storybook film. Each character's motion is made by a text-to-motion model (Kimodo) one short
clip at a time, so you split the scene into beats: one simple full-body action per beat per character.
Reply with the whole plan in ONE JSON object. Rules:
- cast: 1 to 3 characters. character is "avatar_male" or "avatar_female"; kid is true for children.
  starts_at is the place where the character is at the start.
- places: 2 to 6 locations or objects the story needs, with a short key. use is "sit" for something to
  sit on (bench, log, stump), "water" for something at the water's edge (dock, jetty, boat), else "stand".
  Every place, cast member and beat must come from the scene; don't invent extra story.
- water: true only if the scene has a pond, lake, river or sea.
- time_of_day: one of sunrise, day, golden, dusk.
- beats: 3 to 12 in story order, ids b1, b2, ... Give every action the scene names its own beat, for
  every character (e.g. grabs, runs off, shouts, chases, trips, gives back: six beats). Each beat: cast (a cast id), action (a few words for
  the timeline), prompt (for the motion model: starts with "A person", one simple full-body action,
  present tense, no names, e.g. "A person walks forward.", "A person jumps up and cheers with both
  arms."), duration in seconds (2 to 10). Each clip is made on its own, so a character who sat down
  stays seated only if the next prompts say so: every beat until they stand up starts "A person sits
  and ..." ("A person sits and tells a story with big arm gestures.", "A person sits and laughs.").
  If the scene starts with someone sitting, their first beat is "A person sits ..." at that place.
  move_to: a place key or cast id, when the character goes somewhere; then the prompt must be a
  forward locomotion and nothing else ("A person walks forward.", "A person runs forward fast."); put
  what they do on arrival in the next beat, without move_to.
  face: a place key or cast id to turn to at the start of the beat (talking, waving, looking).
  after: the id of an earlier beat of another character; this beat starts when that one ends (a
  reaction). with: the id of an earlier beat of another character; both start together.
  Each character's first beat starts at 0 s unless it has after or with, so a beat that reacts to
  someone else (shouts at, chases, laughs at, waves back) must have after.
- shots: 2 to 6 camera shots in order. framing is wide, medium or close; subject is a cast id, a
  place key or a list of them; until is the id of the beat the shot lasts until.
- thoughts: 2 or 3 short sentences on how you split the scene."""

WORLD_EXAMPLE = {
    "thoughts": ["The cottage and the bench are in the library; the jetty is the small dock.",
                 "A cozy pond-side village: oaks, bushes, flowers and lily pads."],
    "choices": [
        {"place": "cottage", "library": "house"},
        {"place": "bench", "library": "bench"},
        {"place": "jetty", "library": "dock-small"},
        {"place": "well", "generate": {"name": "stone well", "prompt": "a round stone village well with a little wooden roof",
                                        "size_m": 2.5, "category": "village"}},
    ],
    "decor": [
        {"library": "tree-oak", "count": 4, "near": "edge"},
        {"library": "bush", "count": 3, "near": "cottage"},
        {"library": "flower-yellow", "count": 3, "near": "bench"},
        {"library": "lily-pad", "count": 2, "near": "jetty"},
    ],
}

WORLD_SCHEMA = {
    "type": "object",
    "required": ["choices"],
    "properties": {
        "thoughts": {"type": "array", "items": {"type": "string"}},
        "choices": {"type": "array", "items": {"type": "object", "required": ["place"],
                    "properties": {"place": {"type": "string"}, "library": {"type": "string"}, "generate": {"type": "object"}}}},
        "decor": {"type": "array", "items": {"type": "object", "required": ["library"],
                  "properties": {"library": {"type": "string"}, "count": {"type": "number"}, "near": {"type": "string"}}}},
    },
}

WORLD_ROLE = f"""You are the world agent of a team that makes short animated storybook films. You build the set:
for every place in the plan, choose ONE prop. Prefer a library prop: use an id from that place's
search_library results or from the catalog; a close stand-in of the same kind is fine (a tent for a camp,
a stall for a shop). A place marked NO MATCH that matters to the story (a lighthouse, a well, a
windmill) should be generated, not replaced by something of another kind (a rock is no lighthouse).
To make one, use generate instead
(an image-to-3D model makes it, about a minute): name (short), prompt (one object, e.g. "a stone
lighthouse with a red roof"), size_m (real size in meters: the height, but the length for boats, carts, vehicles and docks), category ({' | '.join(GEN_CATEGORIES)}).
At most {MAX_GENERATE} generates per film. Then add decor that sets the mood: 3 to 6 kinds of small library
props with a count each (20 in all at most) that fit the setting: a market gets more stalls, crates,
barrels, carts and lanterns; a camp gets logs, stumps, rocks and pines; a village gets fences, flowers,
bushes and trees. near is a place key or "edge" (the rim of the island, good for trees).
You don't place anything: layout code puts every prop in its spot. Reply with ONE JSON object."""


def _ask(role: str, user: str, schema: dict, example: dict, agent: str, run: str):
    shape = ("Fill in real values for THIS scene; the example below is for a different scene and shows only "
             f"the shape:\n{json.dumps(example, ensure_ascii=False)}")
    return llm.complete([{"role": "system", "content": role}, {"role": "user", "content": user}], schema,
                        agent=agent, temperature=0.4, max_tokens=3000, timeout=120, retries=1, tag=f"{agent}@{run}",
                        shape=shape)


def _run_calls(run: str) -> list[dict]:
    """This run's LLM calls (runs can overlap, so CALLS is filtered by the run id in the tag)."""
    return [c for c in list(llm.CALLS) if c["tag"].endswith(f"@{run}")]


def _answered(tag: str, t0: float) -> str:
    """'nvidia/... in 2.1 s' for the agent log: which tier answered, and any fallbacks."""
    c = llm.last_answer(tag)
    failed = [x for x in list(llm.CALLS) if x["tag"] == tag and not x["ok"]]
    fell = f" (fell back from {', '.join(x['model'] for x in failed)})" if failed else ""
    return f"{c['model'] if c else '?'} in {time.perf_counter() - t0:.1f} s{fell}"


def catalog(manifest: dict) -> str:
    by: dict[str, list[str]] = {}
    for p in manifest["props"]:
        by.setdefault(p.get("category", "other"), []).append(p["id"])
    return "\n".join(f"  {c}: {', '.join(ids)}" for c, ids in by.items())


# ---- repairing the plan ---------------------------------------------------------

def _key(s, used: set) -> str:
    k = slug(str(s or "x"))[:24] or "x"
    base, n = k, 2
    while k in used:
        k, n = f"{base}{n}", n + 1
    used.add(k)
    return k


LOCOMOTION = re.compile(r"\b(walk|walks|run|runs|jog|jogs|sneak|sneaks|skip|skips|stroll|strolls|chase|chases|"
                        r"hurr(y|ies)|dash|dashes|sprint|sprints|limp|limps|tiptoe|tiptoes|march|marches|wander|wanders)\b")


def person_prompt(prompt: str) -> str:
    """Kimodo prompts start with "A person"."""
    p = " ".join(str(prompt).split()).strip().rstrip(".")
    if not p:
        return "A person stands still and looks around."
    if not re.match(r"(?i)^a person\b", p):
        m = re.match(r"(?i)^(?:(?:a|an|the|he|she|they|it)\s+)?(?:[a-z'-]+\s+){0,3}?([a-z]+s)\b(.*)$", p)
        if m and m.group(1).lower() not in {"is", "was", "has"}:
            p = f"A person {m.group(1).lower()}{m.group(2)}"
        else:
            p = "A person " + p[0].lower() + p[1:]
    else:
        p = "A person" + p[8:]
    return p + "."


WATER_WORDS = re.compile(r"\b(pond|lake|river|sea|ocean|dock|pier|jetty|shore|beach|harbou?r|boat|canoe|fish(ing|erman)?|swim\w*|water)\b", re.I)
PURE_MOVE = re.compile(r"^A person (walks|runs|jogs|sneaks|skips|strolls|sprints|dashes|hurries|marches|wanders|limps|tiptoes)"
                       r"( \w+ly)? (forward|ahead|away|off|along)?[\w ,]*\.$")


def repair_plan(raw: dict, scene: str = "") -> tuple[dict, list[str]]:
    """Make a plan consistent: unique keys, known references, clamped numbers.
    Returns the plan and what was fixed (for the log)."""
    fixes = []
    used: set[str] = set()
    places, pmap = [], {}
    for p in (raw.get("places") or [])[:6]:
        if not isinstance(p, dict):
            continue
        k = _key(p.get("key") or p.get("what"), used)
        pmap[str(p.get("key"))] = k
        use = str(p.get("use", "stand")).lower()
        places.append({"key": k, "what": str(p.get("what") or k), "use": use if use in ("sit", "water") else "stand"})
    # "open ground", "the area": not a prop. Fold them into the first real place.
    vague = re.compile(r"^(open |the )?(ground|area|space|clearing|spot|field|middle|center|centre|start|starting|"
                       r"beginning|entrance|offscreen)\b", re.I)
    real = [p for p in places if not (vague.match(p["key"]) or vague.match(p["what"].removeprefix("an ").removeprefix("a ")))]
    nowhere = {raw_k for raw_k, k in pmap.items() if k not in [p["key"] for p in real]}
    if real and len(real) < len(places):
        for p in places:
            if p not in real:
                for raw_k, k in list(pmap.items()):
                    if k == p["key"]:
                        pmap[raw_k] = real[0]["key"]
                fixes.append(f"place {p['key']} ({p['what']}) is no prop: merged into {real[0]['key']}")
        places = real
    cast, cmap = [], {}
    for i, c in enumerate((raw.get("cast") or [])[:3]):
        if not isinstance(c, dict):
            continue
        k = _key(c.get("id") or c.get("name") or f"hero{i}", used)
        cmap[str(c.get("id"))] = k
        ch = str(c.get("character", "")).lower()
        ch = ("avatar_female" if re.search(r"female|woman|girl|lady", ch) else "avatar_male") if ch not in CHARACTERS else ch
        cast.append({"id": k, "name": str(c.get("name") or k.title()), "character": ch,
                     "kid": bool(c.get("kid")), "starts_at": c.get("starts_at")})
    if not cast:
        raise ValueError("the plan has no cast")
    if not places:
        places.append({"key": _key("spot", used), "what": "an open meadow", "use": "stand"})
        fixes.append("no places: added a meadow")

    def ref(x):
        if x is None:
            return None
        x = str(x)
        return pmap.get(x) or cmap.get(x) or (x if x in [p["key"] for p in places] or x in cmap.values() else None)

    for c in cast:
        s = None if str(c["starts_at"]) in nowhere else ref(c["starts_at"])
        c["starts_at"] = s if s in [p["key"] for p in places] else None
    beats, bids = [], set()
    for i, b in enumerate((raw.get("beats") or [])[:12]):
        if not isinstance(b, dict) or cmap.get(str(b.get("cast"))) is None:
            fixes.append(f"dropped a beat with unknown cast {b.get('cast') if isinstance(b, dict) else b!r}")
            continue
        bid = str(b.get("id") or f"b{i + 1}")
        if bid in bids:
            bid = f"b{i + 1}x"
        bids.add(bid)
        prompt = person_prompt(b.get("prompt", ""))
        if prompt != str(b.get("prompt", "")).strip():
            fixes.append(f"{bid}: prompt → “{prompt}”")
        try:
            dur = float(b.get("duration", 4))
        except (TypeError, ValueError):
            dur = 4.0
        nb = {"id": bid, "cast": cmap[str(b["cast"])], "action": str(b.get("action") or prompt[9:].rstrip(".")),
              "prompt": prompt, "duration": min(max(dur, 2.0), MAX_BEAT)}
        for f in ("move_to", "face"):
            r = ref(b.get(f))
            if r and r != nb["cast"]:
                nb[f] = r
        if nb.get("move_to"):
            nb["still_prompt"] = prompt  # used if it turns out they are already there
            if not PURE_MOVE.match(prompt) or not LOCOMOTION.search(prompt.lower()):
                # "trips over the cart" with move_to cart: get there first, then do it.
                fast = re.search(r"\b(run|runs|chase|chases|flee|flees|sprint|dash|hurr)", prompt.lower())
                nb["prompt"] = "A person runs forward fast." if fast else "A person walks forward."
                if re.search(r"\b(stands? up|gets? up|rises|jumps? up)\b", prompt.lower()):
                    nb["first"] = prompt  # stand up, then go
                    fixes.append(f"{bid}: “{prompt}” with move_to → that, then {nb['prompt']}")
                else:
                    nb["then"] = prompt
                    fixes.append(f"{bid}: “{prompt}” with move_to → {nb['prompt']} then the action there")
        for f in ("after", "with"):
            if str(b.get(f)) in bids and str(b.get(f)) != bid:
                nb[f] = str(b[f])
        prev = next((x for x in beats if x["id"] == nb.get("after")), None)
        if prev and prev["cast"] != nb["cast"] and (prev.get("then") or prev["prompt"]) == (nb.get("then") or nb["prompt"]):
            nb["with"] = nb.pop("after")  # "they both stand up": together, not one after the other
            fixes.append(f"{bid}: same action as {prev['id']} → starts with it")
        text = f"{nb['action']} {prompt}".lower()
        if re.search(r"\bchas", text):
            who = next((c["id"] for c in cast if c["id"] != nb["cast"] and
                        (c["id"] in text or c["name"].lower() in text or nb.get("face") == c["id"])), None)
            if who:
                nb["chase"] = who
        if not nb.get("move_to"):
            for m in re.finditer(r"\b(on|onto|at|by|to|in|into|near|beside|past)\s+(?:the |a |an |his |her |their )?([a-z]+)", text):
                k = next((p["key"] for p in places if m.group(2) in (p["key"], p["key"].rstrip("s"))), None)
                if k:
                    nb["past" if m.group(1) == "past" else "goto"] = k
                    break
        beats.append(nb)
    if not beats:
        raise ValueError("the plan has no usable beats")
    tod = str(raw.get("time_of_day", "golden")).lower()
    tod = tod if tod in TIMES else {"morning": "sunrise", "dawn": "sunrise", "noon": "day", "afternoon": "golden",
                                    "evening": "dusk", "sunset": "dusk", "night": "dusk"}.get(tod, "golden")
    shots = []
    for s in (raw.get("shots") or [])[:6]:
        if not isinstance(s, dict):
            continue
        subj = s.get("subject")
        subj = [ref(x) for x in (subj if isinstance(subj, list) else [subj])]
        subj = [x for x in subj if x]
        fr = s.get("framing") if s.get("framing") in ("wide", "medium", "close") else "medium"
        shots.append({"framing": fr, "subject": subj or [c["id"] for c in cast],
                      "until": str(s.get("until")) if str(s.get("until")) in bids else None})
    plan = {"title": str(raw.get("title") or "Untitled"), "time_of_day": tod,
            "water": bool(WATER_WORDS.search(scene)) if scene else bool(raw.get("water")),
            "places": places, "cast": cast, "beats": beats, "shots": shots,
            "thoughts": [str(t) for t in (raw.get("thoughts") or [])][:4]}
    return plan, fixes


def default_world(plan: dict, manifest: dict) -> dict:
    """The world agent's choices without Nemotron: the best search hit per place."""
    ids = {p["id"] for p in manifest["props"]}
    choices = []
    for p in plan["places"]:
        hits = search_library(f"{p['key']} {p['what']}", 1, manifest, p["key"], p["use"])
        choices.append({"place": p["key"], "library": hits[0]["id"] if hits else
                        ("bench" if p["use"] == "sit" else "dock-small" if p["use"] == "water" else "signpost")})
    decor = [{"library": "tree-oak", "count": 4, "near": "edge"}, {"library": "pine-round", "count": 2, "near": "edge"},
             {"library": "bush", "count": 3}, {"library": "flower-yellow", "count": 3}, {"library": "rock-large", "count": 2}]
    return {"choices": choices, "decor": [d for d in decor if d["library"] in ids], "thoughts": []}


def repair_world(raw: dict, plan: dict, manifest: dict) -> tuple[dict, list[str]]:
    fixes = []
    ids = {p["id"] for p in manifest["props"]}
    fallback = {c["place"]: c["library"] for c in default_world(plan, manifest)["choices"]}
    by_place = {}
    gens = 0
    for c in raw.get("choices") or []:
        if not isinstance(c, dict) or c.get("place") not in fallback or c["place"] in by_place:
            continue
        g = c.get("generate")
        if c.get("library") in ids:
            by_place[c["place"]] = {"library": c["library"]}
        elif isinstance(g, dict) and gens < MAX_GENERATE:
            gens += 1
            try:
                size = min(max(float(g.get("size_m", 2)), 0.3), 12.0)
            except (TypeError, ValueError):
                size = 2.0
            name = str(g.get("name") or c["place"])
            cat = g.get("category") if g.get("category") in GEN_CATEGORIES else "village"
            by_place[c["place"]] = {"library": slug(name), "generate": {
                "prompt": str(g.get("prompt") or name), "size_m": size, "category": cat}}
        else:
            if c.get("library"):
                fixes.append(f"{c['place']}: '{c['library']}' isn't in the library → {fallback[c['place']]}")
            elif isinstance(g, dict):
                fixes.append(f"{c['place']}: more than {MAX_GENERATE} generates → {fallback[c['place']]}")
    for k, lib in fallback.items():
        if k not in by_place:
            by_place[k] = {"library": lib}
            fixes.append(f"{k}: no choice → {lib}")
    seats = {p["id"] for p in manifest["props"] if "seat" in p.get("tags", [])}
    for pl in plan["places"]:  # a seat must be something to sit on (a log stack is too tall)
        c = by_place[pl["key"]]
        if pl["use"] == "sit" and not c.get("generate") and c["library"] not in seats and seats:
            new = "bench" if "bench" in pl["what"].lower() and "bench" in seats else \
                "stump" if "stump" in seats else sorted(seats)[0]
            fixes.append(f"{pl['key']}: {c['library']} is no seat → {new}")
            by_place[pl["key"]] = {"library": new}
    decor, total = [], 0
    wet = {p["id"] for p in manifest["props"] if p.get("category") == "water"}
    for d in raw.get("decor") or []:
        if not isinstance(d, dict) or d.get("library") not in ids:
            continue
        if d["library"] in wet and not plan["water"]:
            fixes.append(f"decor {d['library']}: no water in this scene, dropped")
            continue
        try:
            n = int(d.get("count", 1))
        except (TypeError, ValueError):
            n = 1
        n = max(1, min(n, 20 - total))
        if n <= 0:
            break
        total += n
        decor.append({"library": d["library"], "count": n, "near": str(d.get("near") or "")})
    if not decor:
        decor = default_world(plan, manifest)["decor"]
    return {"choices": by_place, "decor": decor, "thoughts": [str(t) for t in (raw.get("thoughts") or [])][:3]}, fixes


# ---- layout: positions, timing, shots ----------------------------------------------

def _heading(a, b) -> float:
    return math.atan2(b[0] - a[0], b[1] - a[1]) / RAD


def _dir(deg) -> tuple[float, float]:
    return math.sin(deg * RAD), math.cos(deg * RAD)


def _r(v, n=2):
    return round(v, n)


def _pt(p):
    return [_r(p[0]), _r(p[1])]


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _along(route, d):
    """The point d meters along a polyline, and the segment's heading."""
    for a, b in zip(route, route[1:]):
        seg = _dist(a, b)
        if d <= seg or b is route[-1]:
            t = min(d / seg, 1) if seg else 0
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), _heading(a, b)
        d -= seg
    return route[-1], 0.0


SPEEDS = [  # m/s, measured on Kimodo (TASKS.md 09a), minus the standing start
    (re.compile(r"\b(sprint|dash|fast|chase|hurr)"), 2.1),
    (re.compile(r"\b(jog)"), 2.4),
    (re.compile(r"\b(run)"), 2.0),
    (re.compile(r"\b(sneak|tiptoe|limp)"), 0.8),
    (re.compile(r"\b(slow|stroll|wander|old)"), 0.85),
    (re.compile(r"\b(skip|march)"), 1.6),
]


def speed_of(prompt: str) -> float:
    p = prompt.lower()
    return next((v for rx, v in SPEEDS if rx.search(p)), 1.45)


def footprint(entry: dict | None, gen: dict | None, scale=1.0) -> float:
    if entry:
        return max(entry["size"][0], entry["size"][2]) / 2 * scale
    return (gen or {}).get("size_m", 2) * 0.35 * scale


def layout(plan: dict, world: dict, manifest: dict, scene: str) -> tuple[dict, list[str]]:
    """Plan + world choices → a scene script (web/js/movie/script.js), and notes for the log."""
    notes = []
    rng = random.Random(int(hashlib.sha1(scene.encode()).hexdigest()[:8], 16))
    entries = {p["id"]: p for p in manifest["props"]}
    places = {p["key"]: dict(p, **world["choices"][p["key"]]) for p in plan["places"]}
    for p in places.values():  # a dock or a boat goes by the water, whatever the plan said
        e = entries.get(p["library"])
        if plan["water"] and e and e.get("category") == "water" and p["library"] != "bridge-wood":
            p["use"] = "water"
        elif p["use"] == "water" and not plan["water"]:
            p["use"] = "stand"

    # Who uses each place (slot order): who starts there, then who goes there.
    users: dict[str, list[str]] = {}
    for c in plan["cast"]:
        if c["starts_at"] in places:
            users.setdefault(c["starts_at"], []).append(c["id"])
    chase_to = {}  # beat id → where the chased one ends up
    for i, b in enumerate(plan["beats"]):
        for k in (b.get("move_to"), b.get("goto")):
            if k in places and b["cast"] not in users.setdefault(k, []):
                users[k].append(b["cast"])
        if b.get("chase"):
            later = [x.get("move_to") or x.get("goto") for x in plan["beats"][i + 1:] if x["cast"] == b["chase"]]
            later = [k for k in later if k in places]
            if later:
                chase_to[b["id"]] = later[-1]
                if b["cast"] not in users.setdefault(later[-1], []):
                    users[later[-1]].append(b["cast"])

    # Visit order: where characters start, then where beats go.
    order = []
    for k in [c["starts_at"] for c in plan["cast"]] + [b.get("move_to") or b.get("goto") for b in plan["beats"]] + list(places):
        if k in places and k not in order:
            order.append(k)
    water = None
    if plan["water"]:
        water = {"shape": "pond", "center": [7.5, 8.5], "radius": 4.8}
    # "A log by the fire", "a bench near the lighthouse": next to that place, not on the route.
    anchor = {}
    for k in order:
        for m in re.finditer(r"\b(?:by|near|beside|next to|around)\s+(?:the |a |an )?([a-z]+)", places[k]["what"].lower()):
            w = m.group(1)
            a = next((o for o in order if o != k and len(w) >= 3 and (w in o or o in w) and o not in anchor
                      and not (places[o]["use"] == "water" and water)), None)
            if a and places[k]["use"] != "water":
                anchor[k] = a
                break
    land = [k for k in order if (places[k]["use"] != "water" or not water) and k not in anchor]
    wet = [k for k in order if k not in land and k not in anchor]

    # The walking route across the island; land places sit beside it.
    route = ([(-10.5, -7.5), (-5.5, -2.5), (-0.5, 1.5), (3.5, 3.5)] if water
             else [(-10.5, -5.5), (-4.5, -1.5), (1.5, 0.5), (7.5, -2.5), (10, -6.5)])
    total = sum(_dist(a, b) for a, b in zip(route, route[1:]))
    n = len(land)
    spacing = min(8.5, total / max(n - 1, 1))
    first = (total - spacing * (n - 1)) / 2 if n > 1 else total / 2
    for i, k in enumerate(land):
        foot, h = _along(route, first + i * spacing)
        p = places[k]
        side = 90 if i % 2 == 0 else -90
        R = footprint(entries.get(p["library"]), p.get("generate"))
        p["R"] = R
        if p["use"] == "sit":  # a seat right beside the route, facing it
            gap = 0.9
        else:
            gap = R + 1.0
        d = _dir(h + side)
        p["center"] = (foot[0] + d[0] * gap, foot[1] + d[1] * gap)
        p["foot"] = foot
        p["face"] = _heading(p["center"], foot)  # the prop's front points at the route
    if water:
        c, r = water["center"], water["radius"]
        toward = _heading(c, (0, 0))
        for i, k in enumerate(wet):
            p = places[k]
            ang = toward + [0, 40, -40, 75][i % 4]
            d = _dir(ang)
            lib = p["library"]
            R = footprint(entries.get(lib), p.get("generate"))
            p["R"] = R
            in_water = re.search(r"boat|canoe|lily|raft", lib)
            off = r - R * (1.2 if in_water else 0.7)
            p["center"] = (c[0] + d[0] * off, c[1] + d[1] * off)
            p["foot"] = (c[0] + d[0] * (r + 1.1), c[1] + d[1] * (r + 1.1))
            p["face"] = _heading(p["center"], c) if not in_water else ang + 90
    for i, (k, a) in enumerate(anchor.items()):
        p, A = places[k], places[a]
        p["R"] = R = footprint(entries.get(p["library"]), p.get("generate"))
        base = _heading(A["center"], A["foot"])  # toward the route
        d = _dir(base + (75 if i % 2 == 0 else -75))
        gap = A["R"] + R + (0.9 if p["use"] == "sit" else 1.2)
        p["center"] = (A["center"][0] + d[0] * gap, A["center"][1] + d[1] * gap)
        if A["R"] < 1.5:  # a fire, a well: face it
            p["face"] = _heading(p["center"], A["center"])
        elif water:  # a bench by the lighthouse looks at the water
            p["face"] = _heading(p["center"], water["center"])
        else:
            p["face"] = _heading(A["center"], p["center"])
        f = _dir(p["face"])
        p["foot"] = (p["center"][0] + f[0] * (R + 0.8), p["center"][1] + f[1] * (R + 0.8))
        p["anchor"] = a
    # Single seats (a stump): one per person who sits there.
    for k, p in places.items():
        e = entries.get(p["library"])
        if not e or "seat" not in e.get("tags", []) or p["library"] == "bench":
            continue
        n_seat = max(1, len(users.get(k, [])))
        A = places.get(p.get("anchor"))
        if A and A["R"] < 1.5 and n_seat > 1:  # around the fire, facing it and each other
            base = _heading(A["center"], p["center"])
            gap = _dist(A["center"], p["center"])
            pts = [(A["center"][0] + _dir(base + 110 * j)[0] * gap, A["center"][1] + _dir(base + 110 * j)[1] * gap)
                   for j in range(n_seat)]
            p["seats"] = [(q, _heading(q, A["center"])) for q in pts]
        else:  # side by side
            along = _dir(p["face"] + 90)
            p["seats"] = [((p["center"][0] + along[0] * 1.1 * j, p["center"][1] + along[1] * 1.1 * j), p["face"])
                          for j in range(n_seat)]
    # "Sits on the dock": a place that is no seat gets a bench in front of it, so nobody sits on air.
    SIT = re.compile(r"\bsits?\b(?! and)")
    for i, b in enumerate(plan["beats"]):
        k = b.get("goto") or next((x.get("move_to") for x in reversed(plan["beats"][:i])
                                   if x["cast"] == b["cast"] and x.get("move_to")), None)
        if not b.get("move_to") and SIT.search(b["prompt"].lower()) and k in places:
            p = places[k]
            e = entries.get(p["library"])
            if p["library"] in SEATS or p.get("seats") or (e and "seat" in e.get("tags", [])) or \
                    re.search(r"boat|canoe|raft", p["library"]) or p.get("bench"):
                continue
            if p["use"] == "water" and water:
                ang = _heading(water["center"], p["foot"])
                d = _dir(ang)
                c = (water["center"][0] + d[0] * (water["radius"] + 1.7), water["center"][1] + d[1] * (water["radius"] + 1.7))
                p["bench"] = (c, _heading(c, water["center"]))
            else:
                d = _dir(_heading(p["center"], p["foot"]))
                c = (p["center"][0] + d[0] * (p["R"] + 1.2), p["center"][1] + d[1] * (p["R"] + 1.2))
                p["bench"] = (c, _heading(p["center"], c))
            notes.append(f"{k}: a bench to sit on")
    # A path from the first place to the last, through each place's foot.
    path_pts = [_pt(places[k]["foot"]) for k in order if k not in anchor]

    # Props for places.
    props = []
    for k in order:
        p = places[k]
        rot = p["face"] + 90 if p["library"] == "bench" else p["face"]  # the bench's front is its -x side
        for j, (pt, face) in enumerate(p.get("seats") or [(p["center"], rot)]):
            prop = {"key": k if j == 0 else f"{k}-{j + 1}", "library": p["library"], "position": _pt(pt),
                    "rotation": _r(((face + 180) % 360) - 180, 0)}
            if p.get("generate"):
                prop["generate"] = p["generate"]
            props.append(prop)
        if p.get("bench"):
            (c, face) = p["bench"]
            props.append({"key": f"{k}-bench", "library": "bench", "position": _pt(c),
                          "rotation": _r(((face + 90 + 180) % 360) - 180, 0)})

    def is_boat(k):
        return bool(water and k in places and places[k]["use"] == "water" and re.search(r"boat|canoe|raft", places[k]["library"]))

    def is_seat(k):
        return k in places and (places[k]["library"] in SEATS or bool(places[k].get("seats") or places[k].get("bench"))
                                or is_boat(k))

    def slot(k, cid):
        p = places[k]
        i = users.get(k, [cid]).index(cid) if cid in users.get(k, []) else 0
        if p.get("seats"):  # sit on it, facing its front
            (q, face) = p["seats"][i % len(p["seats"])]
            f = _dir(face)
            return (q[0] + f[0] * SIT_BACK, q[1] + f[1] * SIT_BACK), face
        if is_boat(k):  # in the boat
            return p["center"], p["face"]
        if p["library"] == "bench" or p.get("bench"):
            c, face = p.get("bench") or (p["center"], p["face"])
            along = _dir(face + 90)
            off = [-0.45, 0.45, 0.0][i % 3]
            front = _dir(face)
            return (c[0] + along[0] * off + front[0] * (SIT_BACK - 0.1), c[1] + along[1] * off + front[1] * (SIT_BACK - 0.1)), face
        if p["use"] == "water" and water:
            ang = _heading(water["center"], p["foot"]) if water else 0
            d = _dir(ang + 90)
            off = [0, 1.0, -1.0][i % 3]
            pt = (p["foot"][0] + d[0] * off, p["foot"][1] + d[1] * off)
            return pt, _heading(pt, p["center"])
        ang = _heading(p["center"], p["foot"]) + [0, 50, -50][i % 3]
        dd = _dir(ang)
        rr = p["R"] + (1.0 if p["use"] == "sit" else 0.7)
        pt = (p["center"][0] + dd[0] * rr, p["center"][1] + dd[1] * rr)
        return pt, _heading(pt, p["center"])

    # Beats are laid out up to three times: a beat that must start "with" another but
    # could only start later holds the other one back (hold) on the next pass.
    hold: dict[str, float] = {}
    n_notes = len(notes)
    for _pass in range(3):
        del notes[n_notes:]
        # Cast start positions.
        cast_out, pos = [], {}
        for i, c in enumerate(plan["cast"]):
            if c["starts_at"]:
                pt, face = slot(c["starts_at"], c["id"])
                first_move = next((b.get("move_to") or b.get("goto") for b in plan["beats"]
                                   if b["cast"] == c["id"] and (b.get("move_to") or b.get("goto"))), None)
                if first_move in places and first_move != c["starts_at"] and not is_seat(c["starts_at"]):
                    face = _heading(pt, places[first_move]["foot"])  # about to leave for it
            else:
                foot, h = _along(route, 1.0 + 2.0 * i)
                pt, face = (foot[0] + 1.2 * i, foot[1] - 1.2 * i), h
            pos[c["id"]] = pt
            out = {"id": c["id"], "name": c["name"], "character": c["character"],
                   "start": {"position": _pt(pt), "facing": _r(((face + 180) % 360) - 180, 0)}}
            natural, want = HEIGHT.get(c["character"], (1.7, 1.7))
            out["scale"] = _r(want / natural * (KID if c["kid"] else 1.0), 3)
            cast_out.append(out)
        cast_by = {c["id"]: c for c in cast_out}

        # Beats: timing from the sync links, walks fitted to their distance.
        cursor = {c["id"]: 0.0 for c in plan["cast"]}
        at_place = {c["id"]: c["starts_at"] for c in plan["cast"]}
        fast = {c["id"]: False for c in plan["cast"]}  # their last move was a run
        timing: dict[str, tuple[float, float]] = {}
        beats = []
        count = {}

        def add(cid, start, dur, prompt, action, **kw):
            count[cid] = count.get(cid, 0) + 1
            start, dur = _r(start), _r(dur, 1)
            b = {"id": f"{cid}-{count[cid]}", "cast": cid, "start": start, "duration": dur,
                 "prompt": prompt, "action": action, **kw}
            beats.append(b)
            cursor[cid] = _r(start + dur)
            return b

        def idle(cid, until):
            # A short wait stretches the last beat if it stays in place (a sit keeps
            # sitting); otherwise an idle beat fills it.
            mine = [x for x in beats if x["cast"] == cid]
            transition = mine and re.search(r"\b(stands? up|gets? up|rises|trips|falls|stumbles|jumps)\b", mine[-1]["prompt"].lower())
            if mine and "to" not in mine[-1] and not transition and until - cursor[cid] > 0.05 and \
                    mine[-1]["duration"] + until - cursor[cid] <= MAX_BEAT:
                mine[-1]["duration"] = _r(until - mine[-1]["start"], 1)
                cursor[cid] = _r(mine[-1]["start"] + mine[-1]["duration"])
                return
            seated = mine and re.search(r"\bsits?\b", mine[-1]["prompt"].lower()) and not transition
            t = cursor[cid]
            while until - t > 1.0:
                d = min(until - t, 8.0)
                add(cid, t, d, "A person sits still and looks around." if seated else "A person stands still and looks around.",
                    "waits", **({"facing": mine[-1]["facing"]} if seated and "facing" in mine[-1] else {}))
                t = cursor[cid]

        def go(cid, dest, prompt, action, start, **extra):
            """Walk (or run) to dest in clips of at most 9 s; later clips are plain locomotion."""
            dist = _dist(pos[cid], dest)
            speed = speed_of(prompt)
            need = dist / speed + 0.7
            parts = max(1, math.ceil(need / 9.0))
            plain = "A person runs forward fast." if speed >= 2.0 else "A person walks forward."
            src = pos[cid]
            for j in range(parts):
                f = (j + 1) / parts
                to = (src[0] + (dest[0] - src[0]) * f, src[1] + (dest[1] - src[1]) * f)
                dur = min(max(need / parts, 2.5), MAX_BEAT)
                add(cid, cursor[cid] if j else start, dur, prompt if j == 0 else plain, action, to=_pt(to),
                    **(extra if j == 0 else {}))
            pos[cid] = dest
            fast[cid] = speed >= 2.0
            return f"{dist:.1f} m at {speed} m/s → {need:.1f} s" + (f" in {parts} beats" if parts > 1 else "")

        def travel_time(cid, dest, prompt):
            need = _dist(pos[cid], dest) / speed_of(prompt) + 0.7
            return max(need, 2.5) if need <= 9.0 else need

        def active(cid):
            return cursor[cid] > 0 or any(x["cast"] == cid for x in beats) or bool(at_place.get(cid))

        for bi, b in enumerate(plan["beats"]):
            cid = b["cast"]
            sync = hold.get(b["id"], 0.0)
            if b.get("after") in timing:
                sync = max(sync, timing[b["after"]][1])
            if b.get("with") in timing:
                sync = max(sync, timing[b["with"]][0])
            start = max(cursor[cid], sync)
            t0 = start
            # A place the action names ("sits on the dock", "trips by the cart"): go there first,
            # leaving early enough to arrive in time.
            pre = b.get("goto") if b.get("goto") in places and b.get("goto") != at_place.get(cid) else None
            if pre:
                dest, _ = slot(pre, cid)
                if _dist(pos[cid], dest) < 0.5:
                    at_place[cid], pre = pre, None
            if pre:
                mp = "A person runs forward fast." if fast[cid] and _dist(pos[cid], dest) > 3.0 else "A person walks forward."
                t_go = max(cursor[cid], sync - travel_time(cid, dest, mp))
                if active(cid):
                    idle(cid, t_go)
                t0 = max(t_go, cursor[cid])
                notes.append(f"{b['id']} {cid} → {pre} first: " + go(cid, dest, mp, b["action"], t0))
                at_place[cid] = pre
                start = max(cursor[cid], sync)
            # Someone placed at the start is on screen from 0 s (without starts_at, they enter later).
            if active(cid):
                idle(cid, start)
            start = max(start, cursor[cid])
            if not pre:
                t0 = start
            mv = b.get("move_to")
            if mv and b.get("first"):
                add(cid, start, 3.0, b["first"], b["action"])
                start = cursor[cid]
            extra = {}
            if b.get("face"):
                extra["facing"] = b["face"]
            if b.get("past") in places:  # "runs past the well": from a few meters before it to a few meters after
                k = b["past"]
                pt, _ = slot(k, cid)
                nxt = next((x.get("move_to") or x.get("goto") for x in plan["beats"][bi + 1:]
                            if x["cast"] == cid and (x.get("move_to") or x.get("goto")) in places), None)
                if _dist(pos[cid], pt) < 2.0:
                    h = _heading(pt, places[nxt]["foot"]) if nxt and nxt != k else _heading(places[k]["center"], pt) + 90
                    if not any(x["cast"] == cid for x in beats):  # first beat: start before the place
                        d = _dir(h + 180)
                        pos[cid] = (pt[0] + d[0] * 4.0, pt[1] + d[1] * 4.0)
                        cast_by[cid]["start"] = {"position": _pt(pos[cid]), "facing": _r(((h + 180) % 360) - 180, 0)}
                else:
                    h = _heading(pos[cid], pt)
                d = _dir(h)
                dest = (pt[0] + d[0] * 3.0, pt[1] + d[1] * 3.0)
                if math.hypot(*dest) > ISLAND:
                    dest = (dest[0] * ISLAND / math.hypot(*dest), dest[1] * ISLAND / math.hypot(*dest))
                dur = min(max(b["duration"], _dist(pos[cid], dest) / speed_of(b["prompt"]) + 0.5), MAX_BEAT)
                add(cid, start, dur, b["prompt"], b["action"], to=_pt(dest))
                pos[cid], at_place[cid] = dest, None
                fast[cid] = speed_of(b["prompt"]) >= 2.0
            elif mv:
                if mv in places:
                    dest, face = slot(mv, cid)
                else:  # another character: stop a meter short of them
                    other = pos.get(mv, (0, 0))
                    h = _heading(other, pos[cid])
                    dest, face = (other[0] + _dir(h)[0] * 1.1, other[1] + _dir(h)[1] * 1.1), h + 180
                dist = _dist(pos[cid], dest)
                if dist < 1.0 and b.get("first"):
                    pass  # stood up already, and is already there
                elif dist < 1.0:  # already there: do the action in place
                    add(cid, start, b["duration"] if b.get("still_prompt") else min(b["duration"], 3),
                        b.get("still_prompt") or "A person turns around and looks.", b["action"],
                        facing=extra.get("facing", mv if mv in places else _r(face, 0)))
                else:
                    notes.append(f"{b['id']} {cid} → {mv}: " + go(cid, dest, b["prompt"], b["action"], start, **extra))
                at_place[cid] = mv if mv in places else None
                fin = chase_to.get(b["id"])
                if fin and fin != mv:  # a chase goes on to where the chased one ends up
                    dest2, _ = slot(fin, cid)
                    notes.append(f"{b['id']} {cid} chases on → {fin}: " + go(cid, dest2, b["prompt"], b["action"], cursor[cid]))
                    at_place[cid] = fin
                if b.get("then") and dist >= 1.0:
                    here = at_place[cid] if at_place[cid] else (mv if mv in pos else None)
                    add(cid, cursor[cid], min(max(b["duration"], 2.0), 6.0), b["then"], b["action"],
                        **({"facing": here} if here else {}))
            else:
                here = at_place.get(cid)
                seated = re.search(r"\bsits?\b", b["prompt"].lower())
                if here in places and ("facing" not in extra or (seated and is_seat(here))):
                    _, face = slot(here, cid)
                    extra["facing"] = _r(((face + 180) % 360) - 180, 0) if is_seat(here) or \
                        (places[here]["use"] == "water" and water) else here
                dur = b["duration"]
                if seated:
                    dur = max(dur, 4.0)
                add(cid, start, dur, b["prompt"], b["action"], **extra)
            timing[b["id"]] = (t0, cursor[cid])

        # Cast without beats of their own (grandpa in his boat): they stay busy, and wave back.
        end = max(cursor.values())
        for c in plan["cast"]:
            cid = c["id"]
            if any(x["cast"] == cid for x in beats):
                continue
            here = at_place.get(cid)
            sit = is_seat(here)
            base = ("A person sits and rows a boat with both arms." if is_boat(here) else
                    "A person sits and looks around." if sit else "A person stands still and looks around.")
            face = {"facing": _r(((slot(here, cid)[1] + 180) % 360) - 180, 0)} if here in places else {}

            def fill(until):
                while until - cursor[cid] > 1.0:
                    add(cid, cursor[cid], min(until - cursor[cid], 8.0), base, "rows" if is_boat(here) else "waits", **face)

            for w in [x for x in sorted(beats, key=lambda x: x["start"]) if x["cast"] != cid and "wave" in x["prompt"].lower()
                      and (x.get("facing") == cid or (here and x.get("facing") == here))]:
                fill(w["start"] + 0.6)
                add(cid, cursor[cid], 3.0, ("A person sits and waves back with one hand." if sit else
                                            "A person waves back with one hand."), "waves back", facing=w["cast"])
                notes.append(f"{cid} has no beats: waves back at {w['cast']} at {w['start'] + 0.6:.1f} s")
            fill(end)

        late = {x["with"]: timing[x["id"]][0] for x in plan["beats"] if x.get("with") in timing and x["id"] in timing
                and timing[x["id"]][0] > timing[x["with"]][0] + 0.3 and timing[x["id"]][0] > hold.get(x["with"], 0)}
        if not late:
            break
        hold.update(late)

    end = max(cursor.values())
    # Nobody freezes at the end: a short idle tail, unless they sat down.
    for c in plan["cast"]:
        last = [x for x in beats if x["cast"] == c["id"]][-1:]
        if last and end - cursor[c["id"]] > 1.5 and not re.search(r"\bsit", last[0]["prompt"].lower()):
            idle(c["id"], end)

    # Someone who is talked to, handed something or waved at looks at them while waiting.
    ids = {c["id"] for c in plan["cast"]}
    for x in beats:
        if x.get("facing") in ids:
            for y in beats:
                if y["cast"] == x["facing"] and y["action"] == "waits" and "facing" not in y and \
                        y["start"] <= x["start"] + 0.5 < y["start"] + y["duration"]:
                    y["facing"] = x["cast"]
    # Same prompt and length for two beats would give the same clip: vary the seed.
    seen = {}
    for x in beats:
        k = (x["prompt"], x["duration"])
        if k in seen:
            x["seed"] = seen[k]
        seen[k] = seen.get(k, 0) + 1

    beats.sort(key=lambda x: (x["start"], x["cast"]))
    if sum(1 for _ in beats) > 16:
        notes.append(f"{len(beats)} beats: that's a lot of Kimodo clips")
    end = max(x["start"] + x["duration"] for x in beats)

    # Shots: each lasts until its beat ends; the last runs to the end.
    cuts = []
    for s in plan["shots"]:
        t = timing.get(s["until"], (0, 0))[1] if s["until"] else 0
        cuts.append(t)
    if not plan["shots"] or not any(cuts):
        ids = [c["id"] for c in plan["cast"]]
        plan_shots = [{"framing": "wide", "subject": ids}, {"framing": "medium", "subject": ids[:1]},
                      {"framing": "wide", "subject": ids}]
        cuts = [end / 3, 2 * end / 3, end]
    else:
        plan_shots = plan["shots"]
        last = 0.0
        for i, t in enumerate(cuts):
            if not t:
                t = last + (end - last) / max(len(cuts) - i, 1)
            cuts[i] = max(t, last + 2.0)
            last = cuts[i]
        cuts[-1] = end
    shots, t = [], 0.0
    angles = [35, -25, 55, 15, -45, 30]
    for i, (s, cut) in enumerate(zip(plan_shots, cuts)):
        if cut <= t + 0.5:
            continue
        cut = end if i == len(plan_shots) - 1 else min(cut, end)
        if cut - t < 0.5:
            continue
        subj = s["subject"]
        shots.append({"id": f"s{len(shots) + 1}", "start": _r(t), "duration": _r(cut - t),
                      "framing": s["framing"], "subject": subj if len(subj) > 1 else subj[0], "angle": angles[i % 6]})
        t = cut
    if t < end - 1e-6:
        if shots:
            shots[-1]["duration"] = _r(end - shots[-1]["start"])
        else:
            shots.append({"id": "s1", "start": 0, "duration": _r(end), "framing": "wide",
                          "subject": [c["id"] for c in plan["cast"]], "angle": 35})

    # Decor, scattered so nothing overlaps the places, the path or the cast.
    taken = [(p["center"], p["R"] + 0.6) for p in places.values()]
    taken += [(q, 1.0) for p in places.values() for q, _ in (p.get("seats") or [])]
    taken += [(p["bench"][0], 1.4) for p in places.values() if p.get("bench")]
    for a, b in zip(path_pts, path_pts[1:]):
        steps = max(1, int(_dist(a, b)))
        taken += [((a[0] + (b[0] - a[0]) * j / steps, a[1] + (b[1] - a[1]) * j / steps), 1.3) for j in range(steps + 1)]
    for x in beats:
        if "to" in x:
            taken.append((tuple(x["to"]), 1.0))
    taken += [(tuple(c["start"]["position"]), 1.0) for c in cast_out]
    if water:
        taken.append((tuple(water["center"]), water["radius"] + 0.6))

    def free(pt, r):
        return math.hypot(*pt) <= ISLAND and all(_dist(pt, q) > r + rq for q, rq in taken)

    n_dec = 0
    for d in world["decor"]:
        e = entries[d["library"]]
        r = footprint(e, None) * 0.9
        near = places.get(d.get("near"))
        for _ in range(d["count"]):
            for _try in range(40):
                if near:
                    ang, rad = rng.uniform(0, 360), near["R"] + rng.uniform(1.2, 3.5)
                    pt = (near["center"][0] + _dir(ang)[0] * rad, near["center"][1] + _dir(ang)[1] * rad)
                elif d.get("near") == "edge" or e["size"][1] > 3:
                    ang, rad = rng.uniform(0, 360), rng.uniform(11, 14.8)
                    pt = (_dir(ang)[0] * rad, _dir(ang)[1] * rad)
                else:
                    ang, rad = rng.uniform(0, 360), rng.uniform(3, 13)
                    pt = (_dir(ang)[0] * rad, _dir(ang)[1] * rad)
                if free(pt, r):
                    n_dec += 1
                    taken.append((pt, r))
                    props.append({"key": f"{d['library']}-{n_dec}", "library": d["library"], "position": _pt(pt),
                                  "rotation": rng.randrange(-180, 180, 15)})
                    break

    terrain = {"time_of_day": plan["time_of_day"]}
    if water:
        terrain["water"] = [water]
    if len(path_pts) > 1:
        terrain["paths"] = [{"points": path_pts, "width": 1.4}]
    script = {"version": 1, "title": plan["title"], "scene": scene, "terrain": terrain,
              "props": props, "cast": cast_out, "beats": beats, "shots": shots}
    return script, notes


# ---- the contract (a port of validateScript in web/js/movie/script.js) ------------------

def validate_script(s: dict) -> list[str]:
    errs = []
    isnum = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
    ispt = lambda p: isinstance(p, list) and len(p) == 2 and all(isnum(v) for v in p)
    keys = set()
    for p in s["props"]:
        if not p.get("key") or p["key"] in keys:
            errs.append(f"prop key {p.get('key')!r} missing or repeated")
        keys.add(p["key"])
        if not ispt(p.get("position")):
            errs.append(f"prop {p['key']}: position")
    cast = set()
    for c in s["cast"]:
        if not c.get("id") or c["id"] in cast or c["id"] in keys:
            errs.append(f"cast id {c.get('id')!r} missing or repeated")
        cast.add(c["id"])
    target = lambda t: ispt(t) or t in keys or t in cast
    last, ids = {}, set()
    for b in s["beats"]:
        if b["id"] in ids:
            errs.append(f"beat {b['id']}: repeated id")
        ids.add(b["id"])
        if b["cast"] not in cast:
            errs.append(f"beat {b['id']}: unknown cast")
        if not (0.5 <= b["duration"] <= MAX_BEAT):
            errs.append(f"beat {b['id']}: duration {b['duration']}")
        if "facing" in b and not isnum(b["facing"]) and not target(b["facing"]):
            errs.append(f"beat {b['id']}: facing {b['facing']!r}")
        if "to" in b and not target(b["to"]):
            errs.append(f"beat {b['id']}: to")
        if b["start"] < last.get(b["cast"], 0) - 1e-6:
            errs.append(f"beat {b['id']}: overlaps")
        last[b["cast"]] = b["start"] + b["duration"]
    t = 0
    for sh in s["shots"]:
        if abs(sh["start"] - t) > 1e-6:
            errs.append(f"shot {sh['id']}: gap")
        subj = sh["subject"] if isinstance(sh["subject"], list) and not ispt(sh["subject"]) else [sh["subject"]]
        if not all(target(x) for x in subj):
            errs.append(f"shot {sh['id']}: subject")
        t = round(sh["start"] + sh["duration"], 2)
    return errs


# ---- the cache -----------------------------------------------------------------

def norm(scene: str) -> str:
    return " ".join(scene.lower().split())


def cache_path(scene: str) -> Path:
    h = hashlib.sha1(norm(scene).encode()).hexdigest()[:10]
    words = "-".join(re.findall(r"[a-z]+", norm(scene))[:5]) or "scene"
    return SCRIPTS / f"{words}-{h}.json"


def load_cached(scene: str) -> dict | None:
    p = cache_path(scene)
    return json.loads(p.read_text()) if p.exists() else None


def closest_cached(scene: str) -> tuple[dict, float] | None:
    want = _words(scene)
    best = None
    for p in SCRIPTS.glob("*.json"):
        try:
            c = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if not c.get("plan"):
            continue
        have = _words(c["scene"])
        score = len(want & have) / max(len(want | have), 1)
        if best is None or score > best[1]:
            best = (c, score)
    return best


def save_cache(scene: str, entry: dict) -> Path:
    SCRIPTS.mkdir(parents=True, exist_ok=True)
    p = cache_path(scene)
    p.write_text(json.dumps(entry, indent=1, ensure_ascii=False) + "\n")
    return p


# ---- the run ----------------------------------------------------------------------

def plan_movie(scene: str, fresh: bool = False) -> Iterator[dict]:
    """Yields {"step": {agent, kind, text, ms}} events, then one
    {"script": ..., "source": "nemotron" | "cache" | "closest cache" | "mock", "llm_calls": n}."""
    scene = scene.strip()
    manifest = load_manifest()

    def step(agent, kind, text, ms=0, **extra):
        return {"step": {"agent": agent, "kind": kind, "text": text, "ms": round(ms), **extra}}

    run = uuid.uuid4().hex[:8]
    cached = None if fresh else load_cached(scene)
    source = "cache" if cached else "nemotron"
    raw_plan = raw_world = None
    if cached:
        raw_plan, raw_world = cached["plan"], cached.get("world")
        yield step("orchestrator", "note", f"Cached plan for this scene from {cached['created'][:16].replace('T', ' ')} "
                   f"({cached.get('model', '?')}): replaying it, 0 LLM calls (?fresh asks Nemotron again).")
    else:
        yield step("orchestrator", "thought", "One Nemotron call returns the whole plan (cast, places, beats, shots); "
                   "layout code then fits positions and timing.")
        yield step("orchestrator", "call", f"nemotron.plan_scene(“{scene[:90]}{'…' if len(scene) > 90 else ''}”) · {llm.model('orchestrator')}")
        t0 = time.perf_counter()
        try:
            raw_plan = _ask(ORCHESTRATOR_ROLE, f"The scene:\n{scene}", PLAN_SCHEMA, PLAN_EXAMPLE, "orchestrator", run)
            yield step("orchestrator", "result", f"plan received from {_answered(f'orchestrator@{run}', t0)}", (time.perf_counter() - t0) * 1000)
        except llm.LLMError as err:
            ms = (time.perf_counter() - t0) * 1000
            yield step("orchestrator", "error", f"Nemotron failed: {str(err)[:200]}", ms)
            near = closest_cached(scene)
            if near and near[1] > 0.0:
                cached, source = near[0], "closest cache"
                raw_plan, raw_world = cached["plan"], cached.get("world")
                yield step("orchestrator", "note", f"Falling back to the closest cached scene ({near[1]:.0%} word overlap): "
                           f"“{cached['scene'][:100]}”")
            else:
                yield step("orchestrator", "note", "No cached scene to fall back on: playing the mock fisherman scene.")
                yield {"script": None, "source": "mock", "llm_calls": len(_run_calls(run))}
                return

    try:
        plan, fixes = repair_plan(raw_plan, scene)
    except ValueError as err:
        yield step("orchestrator", "error", f"unusable plan: {err}; playing the mock fisherman scene.")
        yield {"script": None, "source": "mock", "llm_calls": len(_run_calls(run))}
        return
    for t in plan["thoughts"]:
        yield step("orchestrator", "thought", t)
    yield step("orchestrator", "result",
               f"“{plan['title']}” · {plan['time_of_day']} · cast {', '.join(c['id'] for c in plan['cast'])} · "
               f"places {', '.join(p['key'] for p in plan['places'])} · {len(plan['beats'])} beats · {len(plan['shots'])} shots")
    for f in fixes[:6]:
        yield step("orchestrator", "note", f"repaired: {f}")

    # World agent: search first (tools, no LLM), then one Nemotron call to choose.
    searches = {}
    for p in plan["places"]:
        q = f"{p['key']} {p['what']}"
        yield step("world", "call", f"search_library(“{q}”)")
        t0 = time.perf_counter()
        hits = search_library(q, 5, manifest, p["key"], p["use"])
        searches[p["key"]] = hits
        yield step("world", "result", ", ".join(h["id"] for h in hits) or "no match", (time.perf_counter() - t0) * 1000)
    world_fix = []
    if raw_world is None:
        def matched(p):
            k = _words(p["key"].replace("-", " ")) - STOP
            return any(k & _words(h["id"].replace("-", " ") + " " + " ".join(h["tags"])) for h in searches[p["key"]])
        user = ("The plan's places, each with its search_library results:\n"
                + "\n".join(f"- {p['key']} ({p['what']}, use: {p['use']}): "
                            + (", ".join(f"{h['id']} ({h['height_m']} m; {' '.join(h['tags'])})" for h in searches[p['key']]) or "nothing")
                            + ("" if matched(p) else f"  → NO MATCH: generate a {p['key']} unless the catalog has the same kind of thing")
                            for p in plan["places"])
                + f"\n\nThe scene: {scene}\nTime of day: {plan['time_of_day']}. Water: {'yes' if plan['water'] else 'no'}."
                + f"\n\nThe whole library catalog (ids by category):\n{catalog(manifest)}")
        yield step("world", "call", f"nemotron.pick_props({len(plan['places'])} places) · {llm.model('world')}")
        t0 = time.perf_counter()
        try:
            raw_world = _ask(WORLD_ROLE, user, WORLD_SCHEMA, WORLD_EXAMPLE, "world", run)
            yield step("world", "result", f"choices received from {_answered(f'world@{run}', t0)}", (time.perf_counter() - t0) * 1000)
        except llm.LLMError as err:
            yield step("world", "error", f"Nemotron failed: {str(err)[:200]}", (time.perf_counter() - t0) * 1000)
            yield step("world", "note", "Using the best search_library hit for each place instead.")
            raw_world = None
    world, world_fix = repair_world(raw_world or {}, plan, manifest) if raw_world else (default_world(plan, manifest), [])
    if not raw_world:
        world["choices"] = {c["place"]: {"library": c["library"]} for c in world["choices"]}
    for t in world["thoughts"]:
        yield step("world", "thought", t)
    for k, c in world["choices"].items():
        yield step("world", "result", f"{k} → " + (f"generate_prop('{c['library']}', “{c['generate']['prompt']}”, "
                                                   f"{c['generate']['size_m']} m)" if c.get("generate") else c["library"]))
    for f in world_fix[:6]:
        yield step("world", "note", f"repaired: {f}")
    yield step("world", "result", "decor: " + ", ".join(f"{d['library']} ×{d['count']}" for d in world["decor"]))

    t0 = time.perf_counter()
    script, notes = layout(plan, world, manifest, scene)
    problems = validate_script(script)
    yield step("orchestrator", "call", "layout.fit(beats, distances, sync) · code")
    for nline in notes[:8]:
        yield step("orchestrator", "result", nline)
    if problems:
        for p in problems[:8]:
            yield step("orchestrator", "error", f"script check: {p}")
        yield step("orchestrator", "note", "The laid-out script is invalid (a layout bug): playing the mock fisherman scene.")
        yield {"script": None, "source": "mock", "llm_calls": len(_run_calls(run))}
        return
    film = max(b["start"] + b["duration"] for b in script["beats"])
    yield step("orchestrator", "result", f"script laid out in {(time.perf_counter() - t0) * 1000:.0f} ms · "
               f"{len(script['beats'])} beats · {len(script['props'])} props · {film:.1f} s", (time.perf_counter() - t0) * 1000)

    calls = _run_calls(run)
    n_calls = len(calls)
    if source == "nemotron":
        entry = {"scene": scene, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "model": " + ".join(dict.fromkeys(c["model"] for c in calls if c["ok"])),
                 "backend": llm.backend(),
                 "llm_calls": [{k: c[k] for k in ("agent", "backend", "model", "ok", "seconds")} for c in calls],
                 "llm_seconds": [c["seconds"] for c in calls],
                 "plan": raw_plan, "world": raw_world, "script": script}
        path = save_cache(scene, entry)
        yield step("orchestrator", "note", f"cached in library/scripts/{path.name} ({n_calls} LLM calls)")
    yield {"script": script, "source": source, "llm_calls": n_calls}

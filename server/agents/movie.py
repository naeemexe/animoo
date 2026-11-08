"""The Movie page's planning agents: orchestrator and world, then layout code.

    for event in plan_movie(scene): ...   # {"step": {...}} ... then {"script": ..., "source": ...}

Budget: the OpenCode free tier stops after about 30 Nemotron calls, so a movie
costs **two** calls (plus at most one re-ask each):

1. Orchestrator (one call): the scene text → a *story plan*: title, time of
   day, named places, cast, beats in story order (who does what, a Kimodo
   prompt "A person ...", where they go, who they face, what they wait for).
   No shots (the browser plans those by rules, task 16). No coordinates: small models are bad at geometry.
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

from ..tools.actions import GROUND_WORDS, action_for

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "library" / "scripts"
RAD = math.pi / 180
MAX_BEAT = 10.0
ISLAND = 15.0  # stay inside this radius (the island is 18 m)
TIMES = ["sunrise", "day", "golden", "dusk", "night"]
WEATHERS = ["clear", "rain", "snow", "fog", "windy"]
# Words in the scene text that settle the time of day and the weather, so the
# cached scenes pick them up on replay without asking Nemotron again.
TIME_WORDS = [
    ("night", r"\b(at night|night|midnight|moonlit|moonlight|starry|after dark|in the dark)\b"),
    ("sunrise", r"\b(sunrise|dawn|daybreak|first light|early morning|morning)\b"),
    ("dusk", r"\b(dusk|sunset|twilight|evening|nightfall)\b"),
    ("golden", r"\b(afternoon|golden hour|late day)\b"),
    ("day", r"\b(noon|midday|daytime|sunny|bright day|broad daylight)\b"),
]
WEATHER_WORDS = [
    ("snow", r"\b(snow\w*|blizzard|wintry|frost\w*)\b"),
    ("rain", r"\b(rain\w*|storm\w*|drizzl\w*|downpour|thunder\w*|wet)\b"),
    ("fog", r"\b(fog\w*|mist\w*|haz[ey])\b"),
    ("windy", r"\b(wind\w*|breez\w*|gust\w*|blustery)\b"),
]


# The biome sets the ground, scatter, backdrop and decor (web/js/movie/fill.js).
# First match wins: a "village street" stays a village (forest), a "city park" is a park.
BIOMES = ["forest", "city", "sea", "park", "room", "restaurant"]
INTERIORS = {"room", "restaurant"}  # indoors: a room set, furniture, the interior camera (task 25)
BIOME_WORDS = [
    ("restaurant", r"\b(restaurants?|diner|bistro|cafeteria|pizzeria|tavern|pub|(in|inside) (a|the) (cozy |small |little )?(cafe|café|coffee shop))\b"),
    ("room", r"\b(living room|bedroom|kitchen|dining room|classroom|indoors|(a|the|his|her|their|my|our) (\w+ )?room)\b"),
    ("forest", r"\b(village|forest|woods?|camp\w*|cabin)\b"),
    ("sea", r"\b(beach\w*|sea|seaside|ocean|harbou?r|coast\w*|seashore|surf\w*|sand castle|sandcastle)\b"),
    ("park", r"\b(park|playground|picnic|garden)\b"),
    ("city", r"\b(city|street|downtown|sidewalk|traffic|avenue|crosswalk|bus stop|skyscrapers?|market|plaza|town square|cafe|shop)\b"),
    ("forest", r"\b(meadow|lake|pond|river)\b"),
]


def biome_from_text(text: str) -> str | None:
    t = text.lower()
    return next((k for k, rx in BIOME_WORDS if re.search(rx, t)), None)


def time_from_text(text: str) -> str | None:
    t = text.lower()
    return next((k for k, rx in TIME_WORDS if re.search(rx, t)), None)


def weather_from_text(text: str) -> str | None:
    t = text.lower()
    return next((k for k, rx in WEATHER_WORDS if re.search(rx, t)), None)
CHARACTERS = ["avatar_male", "avatar_female"]
GEN_CATEGORIES = ["buildings", "village", "nature", "vehicles", "water"]
MAX_GENERATE = 2
# The VRMs' own standing heights (measured on the Movie page) and the heights we want:
# the male model is 2.0 m tall, the female 1.54 m.
# Both adults land in 1.65-1.8 m with a small gap (task 22); a kid is KID x that, only when the story asks.
HEIGHT = {"avatar_male": (2.01, 1.76), "avatar_female": (1.54, 1.70)}
KID = 0.8
SEATS = {"bench", "stump", "chair", "armchair", "sofa"}
BENCHLIKE = {"bench": 90, "sofa": 0}  # seats for several, side by side: the model's rotation offset from its front
SIT_BACK = 0.45  # Kimodo's sit-down clips step back 0.1-0.45 m: stand a little in front of the seat  # props a character sits on (others: sit or stand beside them)


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
    "biome": "forest",
    "weather": "clear",
    "water": True,
    "places": [
        {"key": "cottage", "what": "a small cottage", "use": "stand"},
        {"key": "bench", "what": "a wooden park bench", "use": "sit"},
        {"key": "jetty", "what": "a little wooden jetty at the pond", "use": "water"},
    ],
    "cast": [
        {"id": "girl", "name": "Girl", "character": "avatar_female", "kid": True, "starts_at": "cottage",
         "look": {"height_m": 1.3, "top": "yellow", "bottom": "blue", "hair": "auburn", "skin": "light", "accessory": "none"}},
        {"id": "grandpa", "name": "Grandpa", "character": "avatar_male", "kid": False, "starts_at": "cottage",
         "look": {"height_m": 1.72, "top": "green", "bottom": "brown", "hair": "gray", "skin": "tan", "accessory": "cap"}},
    ],
    "beats": [
        {"id": "b1", "cast": "grandpa", "action": "walks to the bench", "prompt": "A person walks forward slowly.", "duration": 6, "move_to": "bench"},
        {"id": "b2", "cast": "girl", "action": "skips to the pond", "prompt": "A person skips forward happily.", "duration": 5, "move_to": "jetty"},
        {"id": "b3", "cast": "grandpa", "action": "sits down", "prompt": "A person sits down on a bench and rests.", "duration": 5},
        {"id": "b4", "cast": "girl", "action": "feeds the ducks", "prompt": "A person crouches down and tosses food with one hand.", "duration": 5, "face": "jetty"},
        {"id": "b5", "cast": "girl", "action": "waves at grandpa", "prompt": "A person waves hello with their right hand.", "duration": 3, "face": "grandpa", "after": "b3"},
    ],
}

PLAN_SCHEMA = {
    "type": "object",
    "required": ["title", "time_of_day", "places", "cast", "beats"],
    "properties": {
        "title": {"type": "string"},
        "thoughts": {"type": "array", "items": {"type": "string"}},
        "time_of_day": {"type": "string"},
        "weather": {"type": "string"},
        "biome": {"type": "string"},
        "water": {"type": "boolean"},
        "places": {"type": "array", "items": {"type": "object", "required": ["key", "what"],
                   "properties": {"key": {"type": "string"}, "what": {"type": "string"}, "use": {"type": "string"}}}},
        "cast": {"type": "array", "items": {"type": "object", "required": ["id"],
                 "properties": {"id": {"type": "string"}, "name": {"type": "string"}, "character": {"type": "string"}}}},
        "beats": {"type": "array", "items": {"type": "object", "required": ["cast", "prompt"],
                  "properties": {"cast": {"type": "string"}, "prompt": {"type": "string"}}}},
    },
}

ORCHESTRATOR_ROLE = """You are the orchestrator of a team of agents that turns a scene description into a short
animated storybook film. Each character's motion is made by a text-to-motion model (Kimodo) one short
clip at a time, so you split the scene into beats: one simple full-body action per beat per character.
Reply with the whole plan in ONE JSON object. Rules:
- cast: 1 to 3 characters. character is "avatar_male" or "avatar_female"; kid is true for children.
  starts_at is the place where the character is at the start.
  look: how the story pictures them, so each cast looks its own: height_m (adults 1.6 to 1.85, kids
  1.1 to 1.45), top and bottom (clothing colors: a color word like red, navy, white, khaki, or #rrggbb;
  a chef in white, a firefighter in red), hair (black, brown, blonde, auburn, red, gray, white),
  skin (pale, light, tan, brown, dark), accessory (none, hat, cap, chef_hat, glasses, apron).
- places: 2 to 6 locations or objects the story needs, with a short key. use is "sit" for something to
  sit on (bench, log, stump), "water" for something at the water's edge (dock, jetty, boat), else "stand".
  Every place, cast member and beat must come from the scene; don't invent extra story.
- biome: one of forest (also villages and camps), city (streets, markets, town squares), sea (beach,
  seaside, harbor), park (a city park or garden), room (indoors: a living room, bedroom, kitchen),
  restaurant (indoors: a restaurant, cafe or diner). Indoors, a table people sit at is a place with use
  "sit" (what: "a table for two"), and a sofa or chair is a place with use "sit".
- water: true only if the scene has a pond, lake, river or sea.
- time_of_day: one of sunrise, day, golden, dusk, night (what the scene says; golden if it says nothing).
- weather: one of clear, rain, snow, fog, windy (clear unless the scene names weather).
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
bushes and trees. The biome sets the rest of the world (fill code adds the ground, the buildings or
forest around the set and the backdrop), so decor is only what stands near the action: a city street gets
lantern-post, bench, hedge, crate, barrel and a truck (never trees or rocks); a sea or harbor scene
gets barrel, crate, chest, rock-large, palm-tree (boats only as places); a park gets bench, hedge, fountain,
lantern-post, flowers, tree-round. near is a place key or "edge" (the rim of the island, good for trees).
A window, door or porch is part of a building: choose house or wooden-cottage for it, never generate a
lone window. A village gets houses (house, wooden-cottage) and lantern-post in the decor; a city shop,
cafe or apartment is a city-building-* prop.
Indoors (biome room or restaurant) everything is furniture: chair, armchair, sofa, dining-table (a table
people sit at; layout puts the chairs around it), table-long, coffee-table, bookshelf, counter, fireplace,
bed, potted-plant, floor-lamp, rug; decor is only furniture (fill code adds the walls, windows, lamps and
the other diners' tables).
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


# Cast looks (task 27): named colors the plan may use, as hex.
COLORS = {
    "black": "#22222a", "white": "#f2f0ea", "gray": "#8a8a8f", "grey": "#8a8a8f", "silver": "#c0c0c6",
    "red": "#c8352e", "crimson": "#a3202a", "maroon": "#6e1f28", "pink": "#e88aa8", "orange": "#e07a2a",
    "yellow": "#efc93a", "gold": "#d6a933", "mustard": "#c9a227", "cream": "#efe4c8", "beige": "#d8c7a3",
    "khaki": "#b5a46e", "tan": "#c49a6c", "brown": "#7a5233", "olive": "#6f7335", "green": "#3f8a45",
    "lime": "#8cc63f", "teal": "#2a8c8a", "cyan": "#3cb7c9", "blue": "#2f5fb0", "navy": "#23305e",
    "denim": "#47648f", "purple": "#6b3fa0", "violet": "#8a5cc2", "lavender": "#b9a3dc",
}
HAIR = {"black": "#1d1a1c", "brown": "#5a3a22", "dark brown": "#3b2618", "light brown": "#8a6040",
        "blonde": "#e0c070", "blond": "#e0c070", "auburn": "#8a3b1f", "red": "#b0451f", "ginger": "#c0571f",
        "gray": "#9a9a9a", "grey": "#9a9a9a", "white": "#e8e6e0", "silver": "#c8c8cc"}
SKIN = {"pale": "#fbe3d4", "fair": "#f6d6c0", "light": "#efc9ab", "medium": "#d9a77f", "tan": "#c48a5e",
        "olive": "#b98a5e", "brown": "#8d5a3b", "dark": "#5e3a26", "deep": "#4a2c1d"}
ACCESSORIES = {"none", "hat", "cap", "chef_hat", "glasses", "apron"}
ADULT_H, KID_H = (1.6, 1.85), (1.1, 1.45)


def _color(v, table) -> str | None:
    v = str(v or "").strip().lower()
    if re.fullmatch(r"#[0-9a-f]{6}", v):
        return v
    if v in table:
        return table[v]
    return next((table[w] for w in sorted(table, key=len, reverse=True) if re.search(rf"\b{w}\b", v)), None)


def repair_look(raw, kid: bool) -> dict | None:
    """The plan's look for one cast member, cleaned: hex colors, a height in range, a known accessory.
    None when the plan gave nothing usable (old plans), so the cast looks as before."""
    if not isinstance(raw, dict):
        return None
    look = {}
    for k, table in (("top", COLORS), ("bottom", COLORS), ("shoes", COLORS), ("hair", HAIR), ("skin", SKIN)):
        c = _color(raw.get(k), table) or (_color(raw.get(k), COLORS) if table is not COLORS else None)
        if c:
            look[k] = c
    h = raw.get("height_m")
    if isinstance(h, (int, float)) and not isinstance(h, bool) and math.isfinite(h):
        lo, hi = KID_H if kid else ADULT_H
        look["height_m"] = round(min(hi, max(lo, float(h))), 2)
    acc = re.sub(r"[\s-]+", "_", str(raw.get("accessory") or "none").strip().lower())
    acc = {"chef's_hat": "chef_hat", "toque": "chef_hat", "baseball_cap": "cap", "spectacles": "glasses"}.get(acc, acc)
    if acc in ACCESSORIES and acc != "none":
        look["accessory"] = acc
    return look or None


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
                # "a spot near the bench" belongs to the bench; anything else to the first real place.
                into = next((r for r in real if re.search(rf"\b{re.escape(r['key'].replace('-', ' '))}\b", p["what"].lower())), None)
                for raw_k, k in list(pmap.items()):
                    if k == p["key"]:
                        pmap[raw_k] = (into or real[0])["key"]
                        if into:
                            nowhere.discard(raw_k)  # a real place to start at
                into = into or real[0]
                fixes.append(f"place {p['key']} ({p['what']}) is no prop: merged into {into['key']}")
        places = real
    cast, cmap = [], {}
    for i, c in enumerate((raw.get("cast") or [])[:3]):
        if not isinstance(c, dict):
            continue
        k = _key(c.get("id") or c.get("name") or f"hero{i}", used)
        cmap[str(c.get("id"))] = k
        ch = str(c.get("character", "")).lower()
        ch = ("avatar_female" if re.search(r"female|woman|girl|lady", ch) else "avatar_male") if ch not in CHARACTERS else ch
        m = {"id": k, "name": str(c.get("name") or k.title()), "character": ch,
             "kid": bool(c.get("kid")), "starts_at": c.get("starts_at")}
        look = repair_look(c.get("look"), m["kid"])
        if look:
            m["look"] = look
        cast.append(m)
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
                                    "evening": "dusk", "sunset": "dusk", "midnight": "night"}.get(tod, "golden")
    wx = str(raw.get("weather", "clear")).lower()
    wx = wx if wx in WEATHERS else {"rainy": "rain", "storm": "rain", "stormy": "rain", "snowy": "snow", "foggy": "fog",
                                    "misty": "fog", "mist": "fog", "wind": "windy", "breezy": "windy"}.get(wx, "clear")
    # The scene's own words win over the model (and fill in old cached plans).
    for name, got, have in (("time_of_day", time_from_text(scene), tod), ("weather", weather_from_text(scene), wx)):
        if got and got != have:
            fixes.append(f"{name} {have} → {got} (from the scene text)")
    tod = time_from_text(scene) or tod
    wx = weather_from_text(scene) or wx
    bio = str(raw.get("biome", "forest")).lower()
    bio = biome_from_text(scene) or (bio if bio in BIOMES else {"beach": "sea", "harbor": "sea", "street": "city", "town": "city",
                                                               "village": "forest", "garden": "park"}.get(bio, "forest"))
    if bio in INTERIORS and wx != "clear":
        fixes.append(f"weather {wx} → clear (indoors)")
        wx = "clear"
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
    plan = {"title": str(raw.get("title") or "Untitled"), "time_of_day": tod, "weather": wx, "biome": bio,
            "water": bio == "sea" or (bio not in INTERIORS and (bool(WATER_WORDS.search(scene)) if scene else bool(raw.get("water")))),
            "places": places, "cast": cast, "beats": beats, "shots": shots,
            "thoughts": [str(t) for t in (raw.get("thoughts") or [])][:4]}
    return plan, fixes


def default_world(plan: dict, manifest: dict) -> dict:
    """The world agent's choices without Nemotron: the best search hit per place."""
    ids = {p["id"] for p in manifest["props"]}
    choices = []
    for p in plan["places"]:
        hits = search_library(f"{p['key']} {p['what']}", 1, manifest, p["key"], p["use"])
        if plan.get("biome") in INTERIORS:
            hits = search_library(f"{p['key']} {p['what']}", 1, {"props": [x for x in manifest["props"] if x.get("category") == "furniture"]}, p["key"], p["use"])
            seat = "dining-table" if TABLE_WORDS.search(f"{p['key']} {p['what']}") else "chair"
            choices.append({"place": p["key"], "library": seat if p["use"] == "sit" and (not hits or hits[0]["id"] not in TABLES | INDOOR_SEATS)
                            else hits[0]["id"] if hits else "potted-plant"})
            continue
        choices.append({"place": p["key"], "library": hits[0]["id"] if hits else
                        ("bench" if p["use"] == "sit" else "dock-small" if p["use"] == "water" else "signpost")})
    decor = BIOME_DECOR.get(plan.get("biome"), BIOME_DECOR["forest"])
    return {"choices": choices, "decor": [d for d in decor if d["library"] in ids], "thoughts": []}


BIOME_DECOR = {
    "forest": [{"library": "tree-oak", "count": 4, "near": "edge"}, {"library": "pine-round", "count": 2, "near": "edge"},
               {"library": "bush", "count": 3}, {"library": "flower-yellow", "count": 3}, {"library": "rock-large", "count": 2}],
    "city": [{"library": "lantern-post", "count": 4}, {"library": "bench", "count": 2}, {"library": "hedge", "count": 3},
             {"library": "crate", "count": 2}, {"library": "truck", "count": 1, "near": "edge"}],
    "sea": [{"library": "barrel", "count": 3}, {"library": "crate", "count": 3}, {"library": "rock-large", "count": 3},
            {"library": "chest", "count": 1}],
    "park": [{"library": "tree-round", "count": 4, "near": "edge"}, {"library": "hedge", "count": 4}, {"library": "lantern-post", "count": 3},
             {"library": "flower-red", "count": 3}, {"library": "bench", "count": 1}],
    "room": [{"library": "potted-plant", "count": 2}, {"library": "floor-lamp", "count": 1}, {"library": "rug", "count": 1},
             {"library": "coffee-table", "count": 1}],
    "restaurant": [{"library": "potted-plant", "count": 2}, {"library": "floor-lamp", "count": 1}],
}
TABLES = {"dining-table"}  # a table people sit at: layout puts chairs around it
INDOOR_SEATS = {"chair", "armchair", "sofa"}
TABLE_WORDS = re.compile(r"\btables?\b", re.I)
INDOOR_SETTING = re.compile(r"\b(room|restaurant|kitchen|floor|inside|indoors|cafe|café|diner|house|home|apartment)\b", re.I)
# Decor that doesn't belong in a biome (the fill adds the city's buildings itself).
NOT_IN = {"city": re.compile(r"^(tree|pine|bush|rock|flower|mushroom|grass|stump|log|house|wooden-cottage|city-)"),
          "sea": re.compile(r"^(mushroom|stump|house|wooden-cottage|city-|lily|flower)"),
          "park": re.compile(r"^(mushroom|stump|log|rock|city-)")}
SETTING = re.compile(r"\b(street|road|sidewalk|square|plaza|path|park|lawn|beach|shore|sand|ground|grass)\b", re.I)
HOUSE_PART = re.compile(r"\b(window|door|doorstep|porch|balcony|room)\b", re.I)
TOWN = re.compile(r"\b(village|street|town|houses?|cottages?|alley|square)\b", re.I)


def repair_world(raw: dict, plan: dict, manifest: dict, scene: str = "") -> tuple[dict, list[str]]:
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
    houses = [i for i in ("wooden-cottage", "house") if i in ids]
    for pl in plan["places"]:  # a window or a door is a house, not a prop of its own
        c = by_place[pl["key"]]
        if plan.get("biome") in INTERIORS:
            break
        if houses and HOUSE_PART.search(f"{pl['key']} {pl['what']}") and c["library"] not in houses:
            fixes.append(f"{pl['key']}: {c['library']} → {houses[0]} (a {pl['key']} belongs to a house)")
            by_place[pl["key"]] = {"library": houses[0]}
    big = {p["id"] for p in manifest["props"] if p.get("category") in ("city", "buildings")}
    furniture = {"props": [p for p in manifest["props"] if p.get("category") == "furniture"]}
    by_id = {p["id"]: p for p in manifest["props"]}
    for pl in plan["places"] if plan.get("biome") in INTERIORS else []:
        # Indoors every place is furniture: the room itself is the set (a rug marks the spot),
        # a table people sit at is a dining table, anything outdoorsy becomes the closest piece.
        c, text = by_place[pl["key"]], f"{pl['key']} {pl['what']}"
        e = by_id.get(c["library"])
        new = None
        if TABLE_WORDS.search(text) and c["library"] not in TABLES:
            if pl["use"] == "sit" or plan.get("biome") == "restaurant":
                new = "dining-table"
            elif c["library"] not in ("table-long", "coffee-table"):
                new = "table-long"
        elif INDOOR_SETTING.search(text) and (c.get("generate") or (e and e.get("category") != "furniture")):
            new = "rug"
        elif c.get("generate") or (e and e.get("category") != "furniture"):
            hits = search_library(text, 1, furniture, pl["key"], pl["use"])
            new = hits[0]["id"] if hits else ("chair" if pl["use"] == "sit" else "potted-plant")
        if pl["use"] == "sit" and (new or c["library"]) not in TABLES | INDOOR_SEATS:
            new = "sofa" if re.search(r"sofa|couch", text, re.I) else "armchair" if "armchair" in text.lower() else \
                "dining-table" if TABLE_WORDS.search(text) else "chair"
        if new and new in ids and new != c["library"]:
            fixes.append(f"{pl['key']}: {c['library']} → {new} (indoors)")
            by_place[pl["key"]] = {"library": new}
    for pl in plan["places"] if plan.get("biome") not in INTERIORS else []:
        c = by_place[pl["key"]]
        # The setting itself ("the street", "a park path") is no building: the fill makes it; a lamp marks the spot.
        if SETTING.search(f"{pl['key']} {pl['what']}") and (c["library"] in big or c.get("generate")) \
                and not re.search(r"\b(shop|cafe|house|building|store|home)\b", pl["what"], re.I):
            mark = "palm-tree" if "palm" in pl["what"].lower() else \
                "lantern-post" if plan.get("biome") in ("city", "park") else "rock-small"
            if mark in ids:
                fixes.append(f"{pl['key']}: {c['library']} → {mark} (the {pl['key']} is the set itself)")
                by_place[pl["key"]] = {"library": mark}
        # A library prop named exactly like the place wins over a stand-in (hedge → hedge, not a pine).
        elif pl["key"] in ids and pl["key"] not in c["library"] and not c.get("generate"):
            fixes.append(f"{pl['key']}: {c['library']} → {pl['key']} (the library has one)")
            by_place[pl["key"]] = {"library": pl["key"]}
        # The big dock is a 2 m platform and layout stands people at its foot (inside it): use the small one.
        if by_place[pl["key"]]["library"] == "dock" and "dock-small" in ids:
            fixes.append(f"{pl['key']}: dock → dock-small (people stand at its foot)")
            by_place[pl["key"]] = {"library": "dock-small"}
    seats = {p["id"] for p in manifest["props"] if "seat" in p.get("tags", [])}
    for pl in plan["places"]:  # a seat must be something to sit on (a log stack is too tall)
        c = by_place[pl["key"]]
        if pl["use"] == "sit" and not c.get("generate") and c["library"] not in seats | TABLES and seats \
                and not GROUND_WORDS.search(f"{pl['key']} {pl['what']}"):  # sitting on the grass needs no seat
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
        if re.search(r"boat|canoe|raft", d["library"]):  # decor lands at random on land; a story boat is a place
            fixes.append(f"decor {d['library']}: a boat isn't decor, dropped")
            continue
        bad = NOT_IN.get(plan.get("biome"))
        indoor_bad = plan.get("biome") in INTERIORS and by_id.get(d["library"], {}).get("category") != "furniture"
        if indoor_bad or (bad and bad.match(d["library"])):
            fixes.append(f"decor {d['library']}: not in a {plan['biome']} scene, dropped")
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
    # A village street needs houses along it (and, at night, the lamps light it).
    blds = {p["id"] for p in manifest["props"] if p.get("category") == "buildings"}
    if houses and plan.get("biome", "forest") == "forest" and TOWN.search(scene) and not any(d["library"] in blds for d in decor) \
            and sum(c["library"] in blds for c in by_place.values()) < 2:
        decor.append({"library": "house", "count": 2, "near": "edge"})
        if "lantern-post" in ids and not any(d["library"] == "lantern-post" for d in decor):
            decor.append({"library": "lantern-post", "count": 2, "near": ""})
        fixes.append("a village street: added houses and lanterns to the decor")
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
    indoors = plan.get("biome") in INTERIORS
    if indoors:  # a room: the same route, shrunk (the walls go around the action)
        route = [(x * 0.42, z * 0.42) for x, z in route]
    total = sum(_dist(a, b) for a, b in zip(route, route[1:]))
    n = len(land)
    spacing = min(3.6 if indoors else 8.5, total / max(n - 1, 1))
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
    # "Walks around the bench to his friend": the prop's front (where people stand or sit)
    # turns away from the route, so the walk really has to go around it (task 22).
    starts = {c["id"]: c["starts_at"] for c in plan["cast"]}
    for k, p in places.items():
        pat = rf"\baround (the |a |his |her )?(\w+ )?{re.escape(k.replace('-', ' '))}\b"
        walker = next((b["cast"] for b in plan["beats"] if re.search(pat, f"{b.get('action', '')} {b['prompt']}".lower())), None)
        if not walker or not p.get("center"):
            continue
        sa = starts.get(walker)
        if sa in places and places[sa].get("center") and sa != k:
            p["face"] = _heading(places[sa]["center"], p["center"])  # long side across the approach, front beyond
        else:
            p["face"] = (p["face"] + 180) % 360
        f = _dir(p["face"])
        p["foot"] = (p["center"][0] + f[0] * (p["R"] + 0.8), p["center"][1] + f[1] * (p["R"] + 0.8))
        notes.append(f"{k}: turned so {walker} has to walk around it")
    # Single seats (a stump): one per person who sits there.
    for k, p in places.items():
        e = entries.get(p["library"])
        if not e or "seat" not in e.get("tags", []) or p["library"] in BENCHLIKE:
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
    # A table people sit at: chairs around it, facing it (two across from each other, side-on to the route).
    for k, p in places.items():
        if p["library"] not in TABLES:
            continue
        n_seat = max(2, len(users.get(k, [])))
        angs = [p["face"] + 90, p["face"] - 90] if n_seat == 2 else [p["face"] + 90 + j * 360 / n_seat for j in range(n_seat)]
        p["seats"] = [((p["center"][0] + _dir(a)[0] * 0.95, p["center"][1] + _dir(a)[1] * 0.95), (a + 180) % 360) for a in angs]
        p["chairs"] = True
        notes.append(f"{k}: {n_seat} chairs around the table")
    # "Sits on the dock": a place that is no seat gets a bench in front of it, so nobody sits on air.
    SIT = re.compile(r"\bsits?\b(?! and)")
    for i, b in enumerate(plan["beats"]):
        k = b.get("goto") or next((x.get("move_to") for x in reversed(plan["beats"][:i])
                                   if x["cast"] == b["cast"] and x.get("move_to")), None)
        if not b.get("move_to") and SIT.search(b["prompt"].lower()) and k in places \
                and not GROUND_WORDS.search(f"{b['prompt']} {b.get('action', '')}"):
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
        rot = p["face"] + BENCHLIKE.get(p["library"], 0)  # the bench's front is its -x side
        if p.get("chairs"):  # the table, then its chairs
            props.append({"key": k, "library": p["library"], "position": _pt(p["center"]), "rotation": _r(((p["face"] + 180) % 360) - 180, 0)})
            for j, (pt, face) in enumerate(p["seats"]):
                props.append({"key": f"{k}-chair{j + 1}", "library": "chair", "position": _pt(pt),
                              "rotation": _r(((face + 180) % 360) - 180, 0)})
            continue
        for j, (pt, face) in enumerate(p.get("seats") or [(p["center"], rot)]):
            prop = {"key": k if j == 0 else f"{k}-{j + 1}", "library": p["library"], "position": _pt(pt),
                    "rotation": _r(((face + 180) % 360) - 180, 0)}
            if p.get("generate"):
                prop["generate"] = p["generate"]
            props.append(prop)
        if p.get("bench"):
            (c, face) = p["bench"]
            seat = "chair" if indoors else "bench"  # indoors a chair (front +z), outdoors a bench (front -x)
            props.append({"key": f"{k}-{seat}", "library": seat, "position": _pt(c),
                          "rotation": _r(((face + BENCHLIKE.get(seat, 0) + 180) % 360) - 180, 0)})

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
            off = 0.15 if p.get("chairs") else SIT_BACK - 0.2  # at a table: the chair's front edge (the hips snap to the seat)
            return (q[0] + f[0] * off, q[1] + f[1] * off), face  # a stump is small
        if is_boat(k):  # in the boat
            return p["center"], p["face"]
        if p["library"] in BENCHLIKE or p.get("bench"):
            c, face = p.get("bench") or (p["center"], p["face"])
            along = _dir(face + 90)
            off = [-0.45, 0.45, 0.0][i % 3]
            front = _dir(face)
            return (c[0] + along[0] * off + front[0] * (SIT_BACK - 0.2), c[1] + along[1] * off + front[1] * (SIT_BACK - 0.2)), face
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
            look = c.get("look")
            if look and look.get("height_m"):
                out["scale"] = _r(look["height_m"] / natural, 3)
            else:
                out["scale"] = _r(want / natural * (KID if c["kid"] else 1.0), 3)
            if look:
                out["look"] = {k: v for k, v in look.items() if k != "height_m"} or None
                if not out["look"]:
                    del out["look"]
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

        def walk_label(prompt, where):
            name = where.replace("_", " ") if isinstance(where, str) else "the spot"
            name = name if name in pos else f"the {name}"
            return f"{'runs' if speed_of(prompt) >= 2.0 else 'walks'} to {name}"

        def go(cid, dest, prompt, action, start, then=None, **extra):
            """Walk (or run) to dest in clips of at most 9 s; later clips are plain locomotion,
            labelled `then` ("walks to the dock") instead of repeating the first clip's action."""
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
                add(cid, cursor[cid] if j else start, dur, prompt if j == 0 else plain,
                    action if j == 0 else (then or action), to=_pt(to),
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
                notes.append(f"{b['id']} {cid} → {pre} first: " + go(cid, dest, mp, walk_label(mp, pre), t0))
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
                    notes.append(f"{b['id']} {cid} → {mv}: " + go(cid, dest, b["prompt"],
                                                           walk_label(b["prompt"], mv) if b.get("then") else b["action"],
                                                           start, then=walk_label(b["prompt"], mv), **extra))
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
                if re.search(r"\b(trips?|falls?|stumbles?|tumbles?)\b", b["prompt"].lower()) and here in places:
                    # falling forward toward the cart would land in it: fall alongside it
                    pt, _ = slot(here, cid)
                    extra["facing"] = _r(((_heading(places[here]["center"], pt) + 90 + 180) % 360) - 180, 0)
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
    notes += tag_motions(beats)
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
        # duration from the rounded edges, so start + duration meets the next start exactly
        shots.append({"id": f"s{len(shots) + 1}", "start": _r(t), "duration": _r(_r(cut) - _r(t)),
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
                    ang, rad = rng.uniform(0, 360), near["R"] + rng.uniform(1.2, 3.5) * (0.6 if indoors else 1)
                    pt = (near["center"][0] + _dir(ang)[0] * rad, near["center"][1] + _dir(ang)[1] * rad)
                elif indoors:  # inside the room, around the action
                    ang, rad = rng.uniform(0, 360), rng.uniform(1.3, 3.6)
                    pt = (_dir(ang)[0] * rad, _dir(ang)[1] * rad)
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
                                  "rotation": _r(((_heading(pt, (0, 0)) + 180) % 360) - 180, 0) if indoors
                                  else rng.randrange(-180, 180, 15)})
                    break

    terrain = {"time_of_day": plan["time_of_day"], "weather": plan.get("weather", "clear"), "biome": plan.get("biome", "forest")}
    if water:
        terrain["water"] = [water]
    if len(path_pts) > 1:
        terrain["paths"] = [{"points": path_pts, "width": 1.4}]
    script = {"version": 1, "title": plan["title"], "scene": scene, "terrain": terrain,
              "props": props, "cast": cast_out, "beats": beats, "shots": shots}
    return script, notes


def tag_motions(beats: list[dict]) -> list[str]:
    """Each beat gets `motion`: an action from the library (server/tools/actions.py),
    or none for a move outside it (Kimodo live, then cached). Tracks sitting, so a
    beat after a sit uses the seated version and a stand-up starts from the right seat."""
    notes, seated = [], {}
    for b in beats:
        text = f"{b.get('action', '')}. {b['prompt']}"
        ground = bool(GROUND_WORDS.search(text))
        m = action_for(text, seated.get(b["cast"]), ground)
        if m:
            b["motion"] = m
        else:
            notes.append(f"{b['id']}: no library action for \"{b['prompt']}\", Kimodo live")
        if m in ("sit_bench", "sit_ground"):
            seated[b["cast"]] = "ground" if m == "sit_ground" else "bench"
        elif not m and re.search(r"\b(trips?|falls?|stumbles?|tumbles?|lies down|kneels?)\b", text.lower()):
            seated[b["cast"]] = "ground"  # down on the ground: the next stand-up is from the ground
        elif not m and re.search(r"\b(sits?|sitting|seated)\b", text.lower()):
            seated.setdefault(b["cast"], "ground" if ground else "bench")  # a live seated move (rowing)
        elif m and m.startswith("stand_up") or m in ("walk", "run", "crouch_walk", "jump", "dance"):
            seated.pop(b["cast"], None)
    return notes


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


def save_edits(scene: str, props: list[dict], camera_paths: list[dict] | None = None) -> Path:
    """Store hand-edited props and camera paths (edit mode) in the scene's cache file; replays use them."""
    p = cache_path(scene.strip())
    if not p.exists():
        raise FileNotFoundError(f"no cached plan for this scene ({p.name}); make the movie once first")
    entry = json.loads(p.read_text())
    old = entry.get("edits", {})
    entry["edits"] = {"saved": datetime.now(timezone.utc).isoformat(timespec="seconds"), "props": props}
    entry.setdefault("script", {})["props"] = props
    paths = old.get("camera_paths", []) if camera_paths is None else camera_paths
    if paths:
        entry["edits"]["camera_paths"] = paths
    entry["script"]["camera_paths"] = paths
    if not paths:
        entry["script"].pop("camera_paths", None)
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
        yield step("orchestrator", "thought", "One Nemotron call returns the whole plan (cast, places, beats; the camera is planned by rules later); "
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
               f"“{plan['title']}” · {plan['time_of_day']}, {plan['weather']} · cast {', '.join(c['id'] for c in plan['cast'])} · "
               f"places {', '.join(p['key'] for p in plan['places'])} · {len(plan['beats'])} beats")
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
                + f"\n\nThe scene: {scene}\nBiome: {plan.get('biome', 'forest')}. Time of day: {plan['time_of_day']}. Weather: {plan['weather']}. Water: {'yes' if plan['water'] else 'no'}."
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
    world, world_fix = repair_world(raw_world or {}, plan, manifest, scene) if raw_world else (default_world(plan, manifest), [])
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
    if cached and cached.get("edits", {}).get("props"):
        # Props placed by hand in the Movie page's edit mode (task 18) win over the layout's.
        script["props"] = cached["edits"]["props"]
        notes = [f"set edited by hand on {cached['edits'].get('saved', '?')[:16].replace('T', ' ')}: "
                 f"{len(script['props'])} props from the edit"] + notes
    if cached and cached.get("edits", {}).get("camera_paths"):
        # Camera paths drawn in edit mode (task 19) override the director for their spans.
        script["camera_paths"] = cached["edits"]["camera_paths"]
        notes = [f"{len(script['camera_paths'])} hand-drawn camera path(s): "
                 + ", ".join(f"{c['start']:.1f}–{c['end']:.1f} s ({len(c['keys'])} keys)" for c in script["camera_paths"])] + notes
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

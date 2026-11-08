"""Scene audio (task 32): an ambience bed and a very soft music bed per scene.

The orchestrator (Nemotron, inside its plan call) proposes `audio`; `repair_audio`
checks it and fills it in from rules (biome, weather, time of day, the scene's own
words) for plans without one, so every cached scene has sound without re-planning.

The script's `audio`:
    {"ambience": {"prompt": str, "layers": {name: level 0-1}},
     "music": {"prompt": str, "mood": MOOD | "none"},
     "volume": 0-1, "source": "nemotron" | "rules"}

The page plays the layers procedurally (web/js/movie/audio.js). With
ELEVENLABS_API_KEY set, /api/movie/audio turns the prompts into mp3s (Sound
Effects for a looping ambience, Music for the bed), cached in library/audio/
with their prompts, and the page prefers those.
"""

from __future__ import annotations

import re

LAYERS = ["rain", "wind", "waves", "birds", "crickets", "traffic", "murmur", "fire"]
MOODS = ["calm", "warm", "tender", "playful", "hopeful", "melancholy", "mysterious", "cozy"]
VOLUME = 0.25  # the default master level: a quiet bed under the picture (about -25 dBFS RMS)

PLACE = {"forest": "in a quiet forest village", "city": "on a city street", "sea": "by the sea",
         "park": "in a city park", "room": "in a cozy room indoors", "restaurant": "in a small restaurant"}
WHEN = {"sunrise": "at sunrise", "day": "on a bright day", "golden": "in the late afternoon",
        "dusk": "at dusk", "night": "at night"}
LAYER_WORDS = {
    "rain": "soft rain", "wind": "a gentle breeze", "waves": "ocean waves washing on the shore",
    "birds": "birdsong", "crickets": "night crickets", "traffic": "distant city traffic",
    "murmur": "quiet chatter and clinking cutlery", "fire": "a crackling fire",
}
SCENE_SOUNDS = [  # the scene's own words name a sound
    ("fire", r"\b(fire\w*|campfire|bonfire|fireplace|hearth)\b", 0.5),
    ("murmur", r"\b(market|busy|crowd\w*|bustl\w*|chatter\w*|party|cafe|café)\b", 0.5),
    ("birds", r"\b(birds?|birdsong|chirp\w*|seagulls?|gulls?|ducks?)\b", 0.5),
    ("waves", r"\b(surf\w*|tides?|(ocean|sea|crashing|the) waves)\b", 0.6),  # not "waves hello"
    ("waves", r"\b(lake|pond|river|dock|jetty|harbou?r|rowboat|boat)\b", 0.2),  # water lapping nearby
    ("traffic", r"\b(traffic|cars?|bus|taxi|honk\w*)\b", 0.5),
    ("crickets", r"\b(crickets?)\b", 0.5),
]
MOOD_WORDS = [
    ("melancholy", r"\b(sad\w*|lonely|alone|miss\w*|cry\w*|tears?|goodbye|farewell|lost)\b"),
    ("mysterious", r"\b(myster\w*|secret\w*|spooky|creep\w*|shadow\w*|strange)\b"),
    ("tender", r"\b(love\w*|date|hug\w*|kiss\w*|propos\w*|romant\w*|grand(ma|pa|mother|father)|for two)\b"),
    ("playful", r"\b(play\w*|laugh\w*|danc\w*|birthday|game|chase\w*|jump\w*|skip\w*|happy|cheer\w*|fun)\b"),
]
NO_MUSIC = re.compile(r"\b(no music|without music|silent film|in silence)\b")
QUIET = re.compile(r"\b(quiet\w*|silent\w*|hush\w*|whisper\w*)\b")


def _clamp(v, lo=0.0, hi=1.0) -> float:
    try:
        return round(max(lo, min(hi, float(v))), 2)
    except (TypeError, ValueError):
        return lo


def rule_layers(scene: str, biome: str, tod: str, weather: str) -> dict:
    t = scene.lower()
    night = tod == "night"
    L = {}
    if biome == "sea":
        L.update(waves=0.8, wind=0.25)
        if not night:
            L["birds"] = 0.25
    elif biome == "forest":
        L.update(wind=0.2)
        L["crickets" if night or tod == "dusk" else "birds"] = 0.55
    elif biome == "park":
        L.update(traffic=0.12, wind=0.15)
        L["crickets" if night else "birds"] = 0.5
    elif biome == "city":
        L.update(traffic=0.45 if night else 0.65, murmur=0.15 if night else 0.25)
    elif biome == "room":
        L.update(fire=0.25 if re.search(r"\bcozy|cosy\b", t) else 0.0)  # a cozy room: a soft fire
    elif biome == "restaurant":
        L.update(murmur=0.6)
    if tod == "sunrise" and "birds" in L:
        L["birds"] = 0.7  # the dawn chorus
    for name, rx, lvl in SCENE_SOUNDS:
        if re.search(rx, t):
            L[name] = max(L.get(name, 0), lvl)
    if night:
        L.pop("birds", None)
    indoors = biome in ("room", "restaurant")
    if weather == "rain" or (indoors and re.search(r"\brain\w*|storm\w*", t)):
        L["rain"] = 0.35 if indoors else 0.8  # indoors: rain on the windows
        L.pop("birds", None)
        if "crickets" in L:
            L["crickets"] = 0.15
    elif weather == "windy":
        L["wind"] = 0.7
    elif weather == "snow":
        L["wind"] = 0.35
        L.pop("birds", None)
        L.pop("crickets", None)
    elif weather == "fog":
        L["wind"] = max(L.get("wind", 0), 0.2)
        if "birds" in L:
            L["birds"] = 0.2
    if biome == "room" and not L.get("fire"):
        L.pop("fire", None)
        if not L:
            L["wind"] = 0.08  # a room is almost silent: just air outside
    return {k: round(v, 2) for k, v in sorted(L.items(), key=lambda kv: -kv[1]) if v > 0}


def rule_mood(scene: str, biome: str, tod: str, weather: str) -> str:
    t = scene.lower()
    for mood, rx in MOOD_WORDS:
        if re.search(rx, t):
            return mood
    if weather == "rain":
        return "melancholy"
    if biome in ("room", "restaurant"):
        return "cozy"
    return {"sunrise": "hopeful", "day": "calm", "golden": "warm", "dusk": "tender", "night": "mysterious"}.get(tod, "calm")


def ambience_prompt(layers: dict, biome: str, tod: str) -> str:
    parts = [LAYER_WORDS[k] for k in layers if k in LAYER_WORDS][:4]
    what = ", ".join(parts) if parts else "a soft, almost silent room tone"
    return f"Ambient soundscape {PLACE.get(biome, 'outdoors')} {WHEN.get(tod, '')}: {what}. Seamless loop, natural, no music, no voices."


def music_prompt(mood: str, biome: str, tod: str) -> str:
    return (f"Very soft, slow {mood} instrumental music bed for a storybook film {PLACE.get(biome, 'outdoors')} "
            f"{WHEN.get(tod, '')}: gentle felt piano and warm pads, sparse, no drums, no vocals, quiet background.")


def repair_audio(raw, scene: str, biome: str, tod: str, weather: str) -> tuple[dict, list[str]]:
    """Nemotron's `audio` checked against the place, or rules when it has none."""
    fixes = []
    t = scene.lower()
    layers = rule_layers(scene, biome, tod, weather)
    mood = rule_mood(scene, biome, tod, weather)
    amb_p = mus_p = None
    source = "rules"
    if isinstance(raw, dict) and raw:
        source = "nemotron"
        amb = raw.get("ambience") if isinstance(raw.get("ambience"), dict) else {}
        mus = raw.get("music") if isinstance(raw.get("music"), dict) else {}
        got = amb.get("layers") or raw.get("layers")
        if isinstance(got, list):  # ["rain", "wind"] or [{"name", "level"}]
            got = {(g.get("name") if isinstance(g, dict) else g): (g.get("level", 0.6) if isinstance(g, dict) else 0.6) for g in got}
        if isinstance(got, dict):
            mine = {str(k).lower(): _clamp(v) for k, v in got.items() if str(k).lower() in LAYERS and _clamp(v) > 0}
            bad = [k for k in got if str(k).lower() not in LAYERS]
            if bad:
                fixes.append(f"audio layers {bad} unknown, dropped")
            if mine:
                # The weather still decides rain/wind; birds don't sing at night.
                for k in ("rain", "wind"):
                    if k in layers and k not in mine:
                        mine[k] = layers[k]
                        fixes.append(f"audio: added {k} ({weather})")
                if tod == "night" and mine.pop("birds", None) is not None:
                    fixes.append("audio: no birds at night")
                layers = dict(sorted(mine.items(), key=lambda kv: -kv[1]))
        if isinstance(amb.get("prompt"), str) and amb["prompt"].strip():
            amb_p = amb["prompt"].strip()[:300]
        m = str(mus.get("mood") or raw.get("mood") or "").lower()
        if m in MOODS or m == "none":
            mood = m
        elif m:
            fixes.append(f"audio mood {m!r} → {mood}")
        if isinstance(mus.get("prompt"), str) and mus["prompt"].strip():
            mus_p = mus["prompt"].strip()[:300]
    if NO_MUSIC.search(t):
        mood = "none"
    volume = VOLUME * (0.6 if QUIET.search(t) else 1.0)
    audio = {
        "ambience": {"prompt": amb_p or ambience_prompt(layers, biome, tod), "layers": layers},
        "music": {"prompt": "" if mood == "none" else (mus_p or music_prompt(mood, biome, tod)), "mood": mood},
        "volume": round(volume, 2),
        "source": source,
    }
    return audio, fixes


def describe(audio: dict) -> str:
    L = audio["ambience"]["layers"]
    amb = " + ".join(f"{k} {v:.1f}" for k, v in L.items()) or "near silence"
    mus = "no music" if audio["music"]["mood"] == "none" else f"soft {audio['music']['mood']} music"
    return f"audio: {amb} · {mus} · volume {audio['volume']:.2f} (from {audio['source']})"

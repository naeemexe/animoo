"""Chat replies for the Chat page: POST /api/chat.

    {messages: [{role: "user" | "assistant", content}]}
      -> {reply, demonstrate: null | {prompt, duration}, source: "nemotron" | "mock", seconds}

Nemotron writes the reply through `server.llm.complete()` (whichever backend
`.env` picks; OpenCode's free Nemotron by default), as JSON checked against
REPLY_SCHEMA. If that call fails, a small rule-based mock answers (greetings,
"show me ..." -> demonstrate), so the page never goes silent.
"""

import re
import time

from . import llm

MIN_DURATION, MAX_DURATION = 2.0, 10.0  # Kimodo is clean up to about 10 s

CHAT_SYSTEM_PROMPT = """You are Mira, a friendly character standing in a small storybook village. You talk with the
user, and you can physically demonstrate movements with your body (a motion generator turns a
short English description into an animation that you then perform).

Answer in JSON only, with exactly these keys:
  {"reply": "<what you say out loud>", "demonstrate": null | {"prompt": "<motion>", "duration": <seconds>}}

Rules for "reply":
- It is spoken aloud by a text-to-speech voice: plain sentences, no markdown, no lists, no emoji.
- Keep it short and warm: one to three sentences, under 60 words.

Rules for "demonstrate":
- Set it when the user asks you to show, teach, demonstrate or do a physical movement
  ("show me a squat", "how do I do a lunge?", "can you dance?"). Otherwise null.
- "prompt" describes one person's whole-body motion in one plain sentence, present tense,
  starting with "A person", e.g. "A person does a slow bodyweight squat and stands back up."
  Describe only the body: no props, no other people, no camera, no emotions-only prompts.
- The person stays roughly in place, standing on flat ground; avoid lying on the floor,
  climbing, sitting on objects or holding things.
- "duration" is in seconds, between 2 and 10; most single moves need 4 to 6.
- When you demonstrate, "reply" says what you are about to do plus one useful tip.
"""


# ---- the real call ---------------------------------------------------------

REPLY_SCHEMA = {
    "type": "object",
    "required": ["reply", "demonstrate"],
    "properties": {
        "reply": {"type": "string"},
        "demonstrate": {"type": ["object", "null"],
                        "properties": {"prompt": {"type": "string"}, "duration": {"type": "number"}}},
    },
}


def _nemotron(messages: list[dict]) -> dict:
    obj = llm.complete([{"role": "system", "content": CHAT_SYSTEM_PROMPT}, *messages], REPLY_SCHEMA,
                       temperature=0.6, max_tokens=400, timeout=30, retries=1, tag="chat",
                       shape='Exactly {"reply": "...", "demonstrate": null} or '
                             '{"reply": "...", "demonstrate": {"prompt": "A person ...", "duration": 5}}.')
    return {"reply": str(obj.get("reply", "")).strip(), "demonstrate": _clean_demo(obj.get("demonstrate"))}


def _clean_demo(d) -> dict | None:
    if not isinstance(d, dict) or not str(d.get("prompt", "")).strip():
        return None
    try:
        duration = float(d.get("duration", 5))
    except (TypeError, ValueError):
        duration = 5.0
    return {"prompt": str(d["prompt"]).strip(), "duration": max(MIN_DURATION, min(MAX_DURATION, duration))}


# ---- the mock ---------------------------------------------------------------

# move keyword -> (Kimodo prompt, duration, spoken tip)
MOVES = [
    (r"squat", "a squat", "A person does a slow bodyweight squat and stands back up.", 5,
     "Feet shoulder width apart, chest up, and push your hips back like you're sitting into a chair."),
    (r"lunge", "a lunge", "A person steps forward into a lunge and steps back to standing.", 5,
     "Step forward and lower until both knees bend to about ninety degrees, then push back."),
    (r"jumping jack", "jumping jacks", "A person does jumping jacks.", 5,
     "Jump your feet out as your arms swing overhead, then jump back together."),
    (r"stretch", "a stretch", "A person stretches both arms up overhead and then leans side to side.", 6,
     "Reach tall, breathe slowly, and never bounce into a stretch."),
    (r"wave", "a wave", "A person waves hello with the right hand.", 3, "A big friendly wave works across any village square."),
    (r"bow", "a bow", "A person bows politely and stands back up.", 3, "Bend from the hips and keep your back straight."),
    (r"danc", "a little dance", "A person dances happily in place.", 6, "Just feel the beat and keep your knees loose."),
    (r"kick", "a front kick", "A person does a front kick with the right leg.", 4,
     "Lift the knee first, then snap the foot out and pull it back."),
    (r"jump", "a jump", "A person jumps up in place and lands softly.", 4, "Land on the balls of your feet with your knees bent."),
    (r"punch|box", "some punches", "A person throws a few boxing punches.", 5, "Keep your guard up and turn your hips into each punch."),
    (r"walk", "a walk", "A person walks forward a few steps and stops.", 5, "Heel first, roll through the foot, and let your arms swing."),
    (r"march", "a march", "A person marches in place, lifting the knees high.", 5,
     "Lift your knees to hip height and swing the opposite arm."),
]

# An explicit request to perform something: any move, known or not.
SHOW = re.compile(r"\b(?:show me|teach me|demonstrate|(?:can|could|would) you (?:do|show|perform)|perform)\b\s*(.*)", re.I)
# "How do I ..." asks for a demonstration only when it names a known move.
HOW = re.compile(r"\bhow (?:do|can|should|would) (?:i|you|we)\b\s*(.*)", re.I)
FILLER = re.compile(r"^(?:me\s+|us\s+|how to\s+|how\s+|to\s+|do\s+|an?\s+|the\s+|some\s+|your\s+)+", re.I)


def _known_move(text: str):
    return next((m for m in MOVES if re.search(m[0], text, re.I)), None)


def mock_reply(messages: list[dict]) -> dict:
    last = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "").strip()
    low = last.lower()

    show, how = SHOW.search(last), HOW.search(last)
    if show or how:
        thing = FILLER.sub("", re.sub(r"[?.!]+$", "", (show or how).group(1))).strip()
        move = _known_move(thing)
        if move:
            _, name, prompt, duration, tip = move
            return {"reply": f"Sure, watch me do {name}. {tip}",
                    "demonstrate": {"prompt": prompt, "duration": duration}}
        if show and thing:
            return {"reply": f"Let me try {thing} for you. Watch closely.",
                    "demonstrate": {"prompt": f"A person demonstrates {thing}.", "duration": 5}}

    if re.search(r"\b(hi|hello|hey|good (morning|afternoon|evening)|howdy)\b", low):
        return {"reply": "Hello there! I'm Mira. Ask me anything, or ask me to show you a move, like a squat.",
                "demonstrate": None}
    if re.search(r"\b(who are you|your name)\b", low):
        return {"reply": "I'm Mira. I live in this little storybook village, and I love showing people how to move.",
                "demonstrate": None}
    if re.search(r"\b(what can you do|help)\b", low):
        return {"reply": "I can chat with you, and I can show you moves with my whole body. Try saying, show me a lunge.",
                "demonstrate": None}
    if re.search(r"\b(thanks|thank you)\b", low):
        return {"reply": "You're very welcome! Want to try another move?", "demonstrate": None}
    if re.search(r"\b(bye|goodbye|see you)\b", low):
        return {"reply": "Goodbye! Come back to the village any time.", "demonstrate": None}
    if last.endswith("?"):
        return {"reply": "That's a lovely question. My real brain, Nemotron, isn't connected yet, so I can't answer "
                         "it properly, but I can show you moves. Try, show me a squat.",
                "demonstrate": None}
    return {"reply": "I hear you! While my full brain is still on its way, I'm best at showing moves. "
                     "Ask me to show you a squat or a dance.",
            "demonstrate": None}


# ---- entry point -------------------------------------------------------------

def chat_reply(messages: list[dict]) -> dict:
    messages = [{"role": m["role"], "content": str(m["content"])} for m in messages
                if m.get("role") in ("user", "assistant") and m.get("content")][-20:]
    t0 = time.perf_counter()
    try:
        out = _nemotron(messages)
        if out["reply"]:
            return {**out, "source": "nemotron", "seconds": round(time.perf_counter() - t0, 2)}
        print("[chat] Nemotron gave an empty reply; using the mock")
    except llm.LLMError as err:
        print(f"[chat] Nemotron failed ({err}); using the mock")
    return {**mock_reply(messages), "source": "mock", "seconds": round(time.perf_counter() - t0, 2)}

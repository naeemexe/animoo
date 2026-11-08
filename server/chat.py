"""Chat replies for the Chat page: POST /api/chat.

    {messages: [{role: "user" | "assistant", content}]}
      -> {reply, demonstrate: null | {prompt, duration}, source: "nemotron" | "mock", seconds,
          error?: "why Nemotron wasn't used"}

Empty `messages` asks for Mira's opening line: she greets the user in her own
words. Nemotron writes every reply through `server.llm.complete()` (whichever
backend `.env` picks), as JSON checked against REPLY_SCHEMA. Only if that call
fails does a small rule-based mock answer ("show me ..." -> demonstrate), with
source "mock" and the error, so the page can say Nemotron is offline.
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
- Keep it short and warm: one to four sentences, under 80 words.
- Answer every question, on any topic (science, maths, physics, history, coding, cooking, anything),
  directly and helpfully, like a clever friend would. Give the real answer or the key steps in brief.
  Never deflect: don't say you can't help, don't say you're "still learning", don't tell them to ask
  about something else, and don't ask them what they meant. If a word looks misspelled, assume the
  most likely meaning ("hamilotional" means Hamiltonian) and answer that.

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
- You are an animated character, so every move is safe for you: backflips, front flips, cartwheels,
  somersaults, splits, breakdancing, martial arts, anything. Never refuse, never warn about safety or
  training, and never swap in a "safer" move: always demonstrate exactly the move that was asked for.
"""


# The opening turn: Mira speaks first, so the model gets this stage direction
# as the user turn (it is never shown or stored in the page's history).
ARRIVAL = ("(Stage direction, not spoken by anyone: a visitor has just walked up to you in the village. "
           "Greet them in your own words, in one or two short sentences, and invite them to talk or to ask "
           "you to show them a movement. Vary it; don't use a stock phrase. demonstrate is null.)")


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
                       agent="chat", temperature=0.6, max_tokens=400, timeout=30, retries=1, tag="chat",
                       shape='Exactly {"reply": "...", "demonstrate": null} or '
                             '{"reply": "...", "demonstrate": {"prompt": "A person ...", "duration": 5}}.')
    out = {"reply": str(obj.get("reply", "")).strip(), "demonstrate": _clean_demo(obj.get("demonstrate"))}
    # A safety net: the user plainly asked to see a known move and the model
    # didn't demonstrate it (it sometimes refuses flips as "unsafe"). Do it anyway.
    if not out["demonstrate"]:
        asked = _asked_move(messages)
        if asked:
            _, name, prompt, duration, tip = asked
            out = {"reply": f"Sure, watch me do {name}. {tip}", "demonstrate": {"prompt": prompt, "duration": duration}}
    return out


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
    (r"back ?flip", "a backflip", "A person jumps up and does a backflip, landing on their feet.", 4,
     "Swing your arms up hard, jump straight up, and tuck your knees to your chest."),
    (r"front ?flip|somersault", "a front flip", "A person jumps up and does a front flip, landing on their feet.", 4,
     "Jump up first, then tuck tight and spot your landing."),
    (r"cartwheel", "a cartwheel", "A person does a cartwheel to the side and stands up.", 4,
     "Hands go down one after the other, and keep your legs straight overhead."),
    (r"march", "a march", "A person marches in place, lifting the knees high.", 5,
     "Lift your knees to hip height and swing the opposite arm."),
]

# An explicit request to perform something: any move, known or not.
SHOW = re.compile(r"(?:\b(?:show me|teach me|demonstrate|(?:can|could|would) you (?:do|show|perform)|perform)\b|^(?:please\s+)?do\b)\s*(.*)", re.I)
# "How do I ..." asks for a demonstration only when it names a known move.
HOW = re.compile(r"\bhow (?:do|can|should|would) (?:i|you|we)\b\s*(.*)", re.I)
FILLER = re.compile(r"^(?:me\s+|us\s+|how to\s+|how\s+|to\s+|do\s+|an?\s+|the\s+|some\s+|your\s+)+", re.I)


def _known_move(text: str):
    return next((m for m in MOVES if re.search(m[0], text, re.I)), None)


def _last_user(messages: list[dict]) -> str:
    return next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "").strip()


def _asked_move(messages: list[dict]):
    """The known move the last user turn asks to see ("show me a backflip", "do a squat"), or None."""
    last = _last_user(messages)
    show, how = SHOW.search(last), HOW.search(last)
    if not (show or how):
        return None
    return _known_move(FILLER.sub("", re.sub(r"[?.!]+$", "", (show or how).group(1))).strip())


def mock_reply(messages: list[dict]) -> dict:
    last = _last_user(messages)

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

    # No small talk in the mock: the page labels this reply as the offline fallback.
    return {"reply": "Nemotron is offline right now, so I can't really talk. "
                     "I can still demonstrate a move if you ask me to show you one.",
            "demonstrate": None}


# ---- entry point -------------------------------------------------------------

def chat_reply(messages: list[dict]) -> dict:
    messages = [{"role": m["role"], "content": str(m["content"])} for m in messages
                if m.get("role") in ("user", "assistant") and m.get("content")][-20:]
    # Opening line (no history), or a history that starts with Mira's greeting:
    # the model sees the stage direction as the first user turn.
    prompt = messages if messages and messages[0]["role"] == "user" else [{"role": "user", "content": ARRIVAL}, *messages]
    t0 = time.perf_counter()
    try:
        out = _nemotron(prompt)
        if out["reply"]:
            return {**out, "source": "nemotron", "seconds": round(time.perf_counter() - t0, 2)}
        error = "Nemotron gave an empty reply"
    except llm.LLMError as err:
        error = f"Nemotron failed: {err}"
    print(f"[chat] {error}; using the mock")
    return {**mock_reply(messages), "source": "mock", "error": error, "seconds": round(time.perf_counter() - t0, 2)}

"""The one LLM client: Nemotron, through whichever backend `.env` picks.

    complete(messages, json_schema=None) -> str            (json_schema is None)
                                         -> dict | list    (json_schema given)

`messages` are OpenAI-style `{role: system|user|assistant, content}`. With a
`json_schema`, the answer is parsed (and repaired) into JSON, checked against
the schema's `required` keys and top-level types, and asked for again up to
`retries` times if it still doesn't fit.

Backends (`LLM_BACKEND` in `.env`):

- `opencode` (default): the locally installed OpenCode CLI, which is the only
  way to reach OpenCode's free Nemotron (`opencode/nemotron-3.5-lightning-free`).
  The free tier refuses any request that isn't OpenCode's stock agent with its
  stock tool list, so a custom agent, disabled tools or `deny` permissions all
  get "Free usage limit reached". What does work: the stock agent with every
  permission set to `ask`. `opencode run` is non-interactive, so it
  auto-rejects every tool call and nothing runs on this machine. The calls run
  in a scratch folder outside the repo (`OPENCODE_DIR`) that holds only that
  `opencode.json`. The whole conversation is flattened into one message.
- `nvidia`: `NVIDIA_API_KEY` at https://integrate.api.nvidia.com/v1.
- `openai`: any OpenAI-compatible server, `NEMOTRON_BASE_URL` + `NEMOTRON_API_KEY`
  (OpenRouter, a self-hosted vLLM, ...).

`NEMOTRON_MODEL` overrides the model for any backend. Tool calling is not
done here: `server/agents/` asks for JSON, so it works the same on all three.

Every call is timed. `CALLS` keeps the last ones ({backend, model, seconds,
ok, chars}) and each one is printed as `[llm] ...`, never with its content.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

DEFAULT_MODELS = {
    "opencode": "opencode/nemotron-3.5-lightning-free",
    "nvidia": "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "openai": "nvidia/nemotron-3-nano-30b-a3b",
}
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
OPENCODE_BIN_DEFAULT = Path.home() / ".opencode" / "bin" / "opencode"
OPENCODE_DIR_DEFAULT = Path.home() / ".cache" / "animo-world" / "opencode"

# Every permission OpenCode knows, set to "ask": `opencode run` then rejects
# each tool call on its own ("permission requested: ...; auto-rejecting").
# "deny" can't be used, because it drops the tools from the request and the
# free tier refuses it. Named keys too, in case a global config allows one.
_ASK = {k: "ask" for k in (
    "*", "bash", "edit", "write", "read", "list", "glob", "grep", "webfetch", "websearch",
    "codesearch", "task", "skill", "todowrite", "todoread", "lsp", "patch", "external_directory",
)}
OPENCODE_CONFIG = {"$schema": "https://opencode.ai/config.json", "permission": _ASK}

CALLS: deque[dict] = deque(maxlen=200)


class LLMError(RuntimeError):
    """The backend failed, timed out, or never produced usable output."""


def backend() -> str:
    return (os.getenv("LLM_BACKEND") or "opencode").strip().lower()


def model() -> str:
    return os.getenv("NEMOTRON_MODEL") or DEFAULT_MODELS.get(backend(), DEFAULT_MODELS["opencode"])


def info() -> dict:
    """Which backend and model are in use (no secrets), for /health."""
    b = backend()
    ready = {
        "opencode": Path(os.getenv("OPENCODE_BIN") or OPENCODE_BIN_DEFAULT).exists(),
        "nvidia": bool(os.getenv("NVIDIA_API_KEY")),
        "openai": bool(os.getenv("NEMOTRON_BASE_URL")),
    }.get(b, False)
    recent = [c["seconds"] for c in CALLS if c["ok"]][-20:]
    return {"backend": b, "model": model(), "ready": ready,
            "calls": len(CALLS), "median_s": sorted(recent)[len(recent) // 2] if recent else None}


# ---- entry point -----------------------------------------------------------

def complete(messages: list[dict], json_schema: dict | None = None, *, temperature: float = 0.4,
             max_tokens: int = 1200, timeout: float = 90, retries: int = 2, tag: str = "",
             shape: str | None = None):
    """One answer from Nemotron: text, or JSON when `json_schema` is given.

    With a schema, the schema is described to the model, the answer is
    repaired and checked, and a bad one is sent back with the problem
    (`retries` times) before LLMError is raised. `shape` replaces the
    schema's generated example when the prompt explains the shape itself."""
    messages = [dict(m) for m in messages]
    if json_schema is not None:
        messages = _with_json_instruction(messages, json_schema, shape)
    last_problem = None
    for attempt in range(retries + 1):
        text = _call(messages, temperature=temperature, max_tokens=max_tokens, timeout=timeout, tag=tag)
        if json_schema is None:
            text = strip_think(text).strip()
            if text:
                return text
            last_problem = "the answer was empty"
        else:
            try:
                obj = parse_json(text)
                problems = check_schema(obj, json_schema)
                if not problems:
                    return obj
                last_problem = "; ".join(problems)
            except ValueError as err:
                last_problem = str(err)
        print(f"[llm] {tag or 'call'}: attempt {attempt + 1} unusable ({last_problem[:120]})")
        messages = [*messages, {"role": "assistant", "content": text[:4000]},
                    {"role": "user", "content": f"That answer can't be used: {last_problem}. "
                     "Reply again with only the corrected JSON object, nothing else."
                     if json_schema is not None else "Please answer again."}]
    raise LLMError(f"no usable answer after {retries + 1} tries: {last_problem}")


def _call(messages, **kw) -> str:
    b, m = backend(), model()
    t0 = time.perf_counter()
    ok, text = False, ""
    try:
        if b == "opencode":
            text = _opencode(messages, m, kw["timeout"])
        elif b == "nvidia":
            key = os.getenv("NVIDIA_API_KEY")
            if not key:
                raise LLMError("LLM_BACKEND=nvidia but NVIDIA_API_KEY is empty")
            text = _openai_compatible(NVIDIA_BASE_URL, key, messages, m, **kw)
        elif b == "openai":
            base = os.getenv("NEMOTRON_BASE_URL")
            if not base:
                raise LLMError("LLM_BACKEND=openai but NEMOTRON_BASE_URL is empty")
            text = _openai_compatible(base, os.getenv("NEMOTRON_API_KEY", ""), messages, m, **kw)
        else:
            raise LLMError(f"unknown LLM_BACKEND {b!r} (use opencode, nvidia or openai)")
        ok = True
        return text
    finally:
        sec = time.perf_counter() - t0
        CALLS.append({"backend": b, "model": m, "seconds": round(sec, 2), "ok": ok,
                      "chars": len(text), "tag": kw.get("tag", ""), "at": time.time()})
        print(f"[llm] {b} {m} {kw.get('tag') or ''} {sec:.2f}s {'ok' if ok else 'FAILED'} {len(text)} chars")


# ---- backends ----------------------------------------------------------------

def _openai_compatible(base: str, key: str, messages, m, *, temperature, max_tokens, timeout, **_) -> str:
    body = {"model": m, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(f"{base.rstrip('/')}/chat/completions",
                                 data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.load(res)
        return data["choices"][0]["message"].get("content") or ""
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, ValueError) as err:
        # Never echo the request: it carries the key.
        raise LLMError(f"{type(err).__name__} {getattr(err, 'code', '')}".strip()) from None


def _opencode_dir() -> Path:
    d = Path(os.getenv("OPENCODE_DIR") or OPENCODE_DIR_DEFAULT)
    d.mkdir(parents=True, exist_ok=True)
    cfg = d / "opencode.json"
    want = json.dumps(OPENCODE_CONFIG, indent=2)
    if not cfg.exists() or cfg.read_text() != want:
        cfg.write_text(want)
    return d


def flatten(messages: list[dict]) -> str:
    """A conversation as one OpenCode message. OpenCode's own system prompt
    (a coding agent) comes first, so this says clearly what the job is."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    turns = [m for m in messages if m["role"] != "system"]
    out = ["You are not working on code in this task. You are the language model behind the Animo World "
           "app, used as a plain text endpoint. Do not use any tools: every tool call is rejected. Do not "
           "read or edit files, do not run commands. Read the instructions and the conversation below, then "
           "write only the next ASSISTANT message, exactly in the format the instructions ask for."]
    if system:
        out.append(f"=== INSTRUCTIONS ===\n{system}")
    if len(turns) == 1 and turns[0]["role"] == "user":
        out.append(f"=== USER MESSAGE ===\n{turns[0]['content']}")
    else:
        convo = "\n\n".join(f"[{m['role'].upper()}]\n{m['content']}" for m in turns)
        out.append(f"=== CONVERSATION ===\n{convo}")
    out.append("=== YOUR TURN ===\nWrite the next ASSISTANT message now, and nothing else.")
    return "\n\n".join(out)


# When the free tier refuses ("Free usage limit reached"), OpenCode retries
# quietly for minutes. The refusal shows up in its log on stderr within about a
# second, so the call is killed then, and OpenCode is skipped for
# OPENCODE_COOLDOWN_S so callers (Chat) fall back at once instead of waiting.
LIMIT_MARK = "Free usage limit reached"
_cooldown_until = 0.0


def _opencode(messages, m, timeout) -> str:
    global _cooldown_until
    if time.time() < _cooldown_until:
        raise LLMError(f"OpenCode free tier is rate-limited; retrying in {_cooldown_until - time.time():.0f}s")
    binary = os.getenv("OPENCODE_BIN") or str(OPENCODE_BIN_DEFAULT)
    cmd = [binary, "run", "--pure", "--print-logs", "--log-level", "WARN", "--format", "json", "-m", m,
           flatten(messages)]
    try:
        # stdin must be closed: with an open pipe, `opencode run` waits on it forever.
        proc = subprocess.Popen(cmd, cwd=_opencode_dir(), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
    except FileNotFoundError:
        raise LLMError(f"OpenCode CLI not found at {binary}") from None
    limited = threading.Event()

    def watch_stderr():  # read only for the limit marker; the log is never stored or printed
        for line in proc.stderr:
            if LIMIT_MARK in line:
                limited.set()
                proc.kill()

    watcher = threading.Thread(target=watch_stderr, daemon=True)
    watcher.start()
    try:
        stdout, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise LLMError(f"opencode timed out after {timeout:.0f}s") from None
    finally:
        watcher.join(timeout=1)
    if limited.is_set():
        cool = float(os.getenv("OPENCODE_COOLDOWN_S") or 120)
        _cooldown_until = time.time() + cool
        raise LLMError(f"OpenCode free tier is rate-limited ({LIMIT_MARK}); skipping it for {cool:.0f}s")
    texts, errors, tools = [], [], []
    for line in stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        part = ev.get("part") or {}
        if ev.get("type") == "text" and part.get("text"):
            texts.append(part["text"])
        elif ev.get("type") == "tool_use":
            tools.append(part.get("tool", "?"))
        elif ev.get("type") == "error":
            errors.append(str(ev.get("error") or part)[:300])
    if tools:
        print(f"[llm] opencode: the model tried tools {tools} (all rejected)")
    if not texts:
        why = errors[0] if errors else f"exit {proc.returncode}"
        raise LLMError(f"opencode returned no text ({why})")
    return "\n".join(texts)


# ---- JSON: instruction, repair, check ----------------------------------------

def sketch(schema: dict):
    """A placeholder example of a schema, e.g. {"capital": "<string: the city>"}.
    Shown to the model instead of the schema, which small models tend to copy
    back verbatim."""
    if "example" in schema:
        return schema["example"]
    t = schema.get("type")
    t = t[0] if isinstance(t, list) else t
    desc = f": {schema['description']}" if schema.get("description") else ""
    if "enum" in schema:
        return " | ".join(map(str, schema["enum"]))
    if t == "object" or "properties" in schema:
        return {k: sketch(v) for k, v in (schema.get("properties") or {}).items()}
    if t == "array":
        return [sketch(schema.get("items") or {})]
    return f"<{t or 'value'}{desc}>"


def _with_json_instruction(messages, schema, shape=None) -> list[dict]:
    required = schema.get("required") or []
    note = ("Answer with one JSON object only: no prose before or after it, no markdown fences, no schema. "
            "Fill in real values. "
            + (shape or ("Its shape (each <...> is a placeholder for a real value):\n"
                         f"{json.dumps(sketch(schema), indent=1)}"
                         + (f"\nRequired keys: {', '.join(required)}." if required else ""))))
    if messages and messages[0]["role"] == "system":
        return [{"role": "system", "content": f"{messages[0]['content']}\n\n{note}"}, *messages[1:]]
    return [{"role": "system", "content": note}, *messages]


def strip_think(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    return re.sub(r"^.*?</think>", "", text, flags=re.S)  # an unopened block


def _balanced(text: str, start: int) -> str | None:
    """The {...} or [...] that starts at `start`, honouring strings."""
    open_c = text[start]
    close_c = "}" if open_c == "{" else "]"
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c in "{[":
            depth += 1
        elif c in "}]":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _repairs(s: str):
    yield s
    t = s.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    t = re.sub(r",\s*([}\]])", r"\1", t)  # trailing commas
    t = re.sub(r"//[^\n\"]*$", "", t, flags=re.M)  # line comments
    yield t
    # Python-ish literals and single quotes: ast handles those.
    py = re.sub(r"\btrue\b", "True", re.sub(r"\bfalse\b", "False", re.sub(r"\bnull\b", "None", t)))
    yield ("ast", py)


def parse_json(text: str):
    """The first JSON object (or array) in a model answer, repaired if needed.
    Handles think blocks, ```json fences, prose around it, trailing commas,
    smart quotes, single quotes and an unclosed object at the very end."""
    text = strip_think(text)
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    candidates = [fence.group(1)] if fence else []
    starts = [i for i, c in enumerate(text) if c in "{["]
    for i in starts[:5]:
        block = _balanced(text, i)
        if block:
            candidates.append(block)
        else:  # cut off: close what is open
            tail = text[i:].rstrip()
            opens = tail.count("{") - tail.count("}")
            sq = tail.count("[") - tail.count("]")
            if tail.count('"') % 2:
                tail += '"'
            candidates.append(tail + "]" * max(sq, 0) + "}" * max(opens, 0))
    for cand in candidates:
        for fixed in _repairs(cand.strip()):
            try:
                if isinstance(fixed, tuple):
                    obj = ast.literal_eval(fixed[1])
                else:
                    obj = json.loads(fixed)
                if isinstance(obj, (dict, list)):
                    return obj
            except (ValueError, SyntaxError, MemoryError, RecursionError):
                continue
    raise ValueError("the answer contains no valid JSON object" if starts else "the answer is not JSON")


_TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None),
          "integer": int, "number": (int, float)}


def check_schema(obj, schema: dict, path: str = "") -> list[str]:
    """A small JSON-schema check: type, required, properties, enum, items.
    Enough to catch what models get wrong; not a full validator."""
    problems = []
    want = schema.get("type")
    if want:
        kinds = want if isinstance(want, list) else [want]

        def fits(kind):
            if isinstance(obj, bool) and kind != "boolean":
                return False  # bool is an int in Python, not in JSON
            return isinstance(obj, _TYPES.get(kind, object))

        if not any(fits(k) for k in kinds):
            return [f"{path or 'the answer'} should be {' or '.join(kinds)}, not {type(obj).__name__}"]
    if "enum" in schema and obj not in schema["enum"]:
        problems.append(f"{path or 'value'} must be one of {schema['enum']}")
    if isinstance(obj, dict):
        for key in schema.get("required", []):
            if key not in obj:
                problems.append(f"missing key {path + '.' if path else ''}{key}")
        for key, sub in (schema.get("properties") or {}).items():
            if key in obj:
                problems += check_schema(obj[key], sub, f"{path + '.' if path else ''}{key}")
    if isinstance(obj, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(obj[:50]):
            problems += check_schema(item, schema["items"], f"{path}[{i}]")
    return problems

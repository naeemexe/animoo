"""A generic tool-calling agent loop on top of `server.llm.complete()`.

Tool calling uses our own JSON protocol, not the backend's native tools, so it
works the same on OpenCode, NVIDIA's API or any OpenAI-compatible server.
Each turn the model answers with exactly one JSON object:

    {"thought": "...", "call": {"tool": "<name>", "args": {...}}}   use a tool
    {"thought": "...", "final": <answer>}                           finish

`run()` is a generator of steps, in the shape the Movie page's agent log
already draws (`web/js/movie/page.js`):

    {agent, kind: "thought" | "call" | "result" | "final" | "error", text, ms, data?}

`ms` is how long that step took (the LLM call for a thought, the tool for a
result). Malformed JSON is repaired and retried inside `complete()`; an
unknown tool, bad arguments or a tool that raises are sent back to the model
as the tool's result, so it can correct itself.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .. import llm


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict  # JSON schema of the args object
    fn: Callable[..., Any]

    def describe(self) -> str:
        props = self.parameters.get("properties", {})
        req = set(self.parameters.get("required", []))
        args = ", ".join(f"{k}: {v.get('type', 'any')}{'' if k in req else '?'}"
                         + (f" ({v['description']})" if v.get("description") else "")
                         for k, v in props.items())
        return f"- {self.name}({args}): {self.description}"


@dataclass
class Agent:
    name: str  # also the log's agent label: orchestrator, world, motion, director, test, ...
    role: str  # what this agent is for, in a few sentences
    tools: list[Tool] = field(default_factory=list)
    final_schema: dict | None = None  # JSON schema of "final", if it has one
    max_steps: int = 8
    temperature: float = 0.3

    def system_prompt(self) -> str:
        final = (f"\n\"final\" must match this shape: {json.dumps(llm.sketch(self.final_schema))}"
                 if self.final_schema else "")
        tools = "\n".join(t.describe() for t in self.tools) or "(none)"
        return f"""{self.role}

You work in steps. Each reply is ONE JSON object, nothing else. Either call one tool:
  {{"thought": "<one short sentence: what you do next and why>", "call": {{"tool": "<tool name>", "args": {{...}}}}}}
or, when you have everything you need, finish:
  {{"thought": "<one short sentence>", "final": <your answer>}}{final}

After a call you get the tool's result in the next message, starting with TOOL RESULT. Call one tool
per reply and wait for its result; never invent results. Use only these tools, with exactly these
argument names (a ? marks an optional one):
{tools}"""


STEP_SCHEMA = {
    "type": "object",
    "required": ["thought"],
    "properties": {
        "thought": {"type": "string"},
        "call": {"type": "object", "required": ["tool"],
                 "properties": {"tool": {"type": "string"}, "args": {"type": "object"}}},
        "final": {},
    },
}


def _step(agent, kind, text, ms=0, **extra) -> dict:
    return {"agent": agent.name, "kind": kind, "text": text, "ms": round(ms), **extra}


def _short(value, limit=240) -> str:
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def run(agent: Agent, task: str) -> Iterator[dict]:
    """Run `agent` on `task`, yielding each step as it happens. The last step
    is `final` (with `data` = the answer) or `error`."""
    tools = {t.name: t for t in agent.tools}
    messages = [{"role": "system", "content": agent.system_prompt()}, {"role": "user", "content": task}]
    for n in range(agent.max_steps):
        t0 = time.perf_counter()
        try:
            reply = llm.complete(messages, STEP_SCHEMA, agent=agent.name, temperature=agent.temperature,
                                 tag=f"{agent.name}#{n}",
                                 shape='The shape is {"thought": ..., "call": {"tool": ..., "args": {...}}} '
                                       'or {"thought": ..., "final": ...}, as described above.')
        except llm.LLMError as err:
            yield _step(agent, "error", f"Nemotron failed: {err}", (time.perf_counter() - t0) * 1000)
            return
        ms = (time.perf_counter() - t0) * 1000
        messages.append({"role": "assistant", "content": json.dumps(reply, ensure_ascii=False)})
        thought = str(reply.get("thought", "")).strip()
        if thought:
            yield _step(agent, "thought", thought, ms, llm_ms=round(ms))

        call = reply.get("call")
        if "final" in reply and not call:
            final = reply["final"]
            problems = llm.check_schema(final, agent.final_schema) if agent.final_schema else []
            if problems:
                yield _step(agent, "error", f"final answer rejected: {'; '.join(problems)}", 0)
                messages.append({"role": "user", "content": f"TOOL RESULT (system): your final answer is invalid: "
                                 f"{'; '.join(problems)}. Fix it and reply with the corrected final."})
                continue
            yield _step(agent, "final", _short(final, 400), 0, data=final)
            return
        if not isinstance(call, dict):
            messages.append({"role": "user", "content": "TOOL RESULT (system): your reply had neither a \"call\" "
                             "nor a \"final\". Reply with one of them."})
            continue

        name, args = str(call.get("tool", "")), call.get("args") or {}
        yield _step(agent, "call", f"{name}({', '.join(f'{k}={json.dumps(v, ensure_ascii=False)}' for k, v in args.items())})",
                    0, data={"tool": name, "args": args})
        t1 = time.perf_counter()
        tool = tools.get(name)
        if tool is None:
            result, ok = {"error": f"unknown tool {name!r}; the tools are {sorted(tools)}"}, False
        else:
            problems = llm.check_schema(args, tool.parameters)
            if problems:
                result, ok = {"error": "bad arguments: " + "; ".join(problems)}, False
            else:
                try:
                    result, ok = tool.fn(**args), True
                except Exception as err:  # the model sees the error and can retry
                    result, ok = {"error": f"{type(err).__name__}: {err}"}, False
        tool_ms = (time.perf_counter() - t1) * 1000
        yield _step(agent, "result" if ok else "error", _short(result), tool_ms, data=result)
        messages.append({"role": "user", "content": f"TOOL RESULT ({name}): {json.dumps(result, ensure_ascii=False)}"})

    yield _step(agent, "error", f"gave up after {agent.max_steps} steps without a final answer")

"""Agents: the loop (`loop.py`) and the agents the app can run, by name.

`GET /api/agents/{name}/run?task=...` streams a run as server-sent events
(see `server/app.py`)."""

from .loop import Agent, Tool, run
from .test_agent import TEST_AGENT

AGENTS: dict[str, Agent] = {"test": TEST_AGENT}

__all__ = ["AGENTS", "Agent", "Tool", "run"]

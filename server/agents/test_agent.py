"""A test agent with one dummy tool, to check the loop end to end.

`distance(from_place, to_place)` returns the walking distance between two
landmarks of a made-up village. The default task needs two calls and a
comparison, so a run shows thought → call → result twice, then a final.
"""

import math

from .loop import Agent, Tool

PLACES = {  # x, z in meters
    "well": (0.0, 0.0),
    "windmill": (4.5, -11.0),
    "dock": (-9.0, 6.0),
    "hut": (3.0, 5.0),
    "bench": (-6.5, 2.0),
}

DEFAULT_TASK = "Which is closer to the well, the windmill or the dock? Give both distances."


def distance(from_place: str, to_place: str) -> dict:
    a, b = from_place.strip().lower(), to_place.strip().lower()
    missing = [p for p in (a, b) if p not in PLACES]
    if missing:
        raise KeyError(f"no place called {missing[0]!r}; the places are {sorted(PLACES)}")
    (x1, z1), (x2, z2) = PLACES[a], PLACES[b]
    return {"from": a, "to": b, "meters": round(math.hypot(x2 - x1, z2 - z1), 1)}


DISTANCE = Tool(
    name="distance",
    description="Walking distance in meters between two places in the village "
                f"({', '.join(sorted(PLACES))}).",
    parameters={"type": "object", "required": ["from_place", "to_place"],
                "properties": {"from_place": {"type": "string"}, "to_place": {"type": "string"}}},
    fn=distance,
)

TEST_AGENT = Agent(
    name="test",
    role="You are a helper in a small storybook village. You answer questions about where things "
         "are, using the distance tool for every distance you mention.",
    tools=[DISTANCE],
    final_schema={"type": "object", "required": ["answer"],
                  "properties": {"answer": {"type": "string", "description": "one or two sentences"}}},
    max_steps=6,
)

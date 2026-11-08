# Feedback

Write anything here as you try the app: bugs, things that look wrong, ideas,
things you want next. Rough notes are fine. The main session turns each one
into a task in `TASKS.md`.

**Where to try things** (the app runs at http://localhost:8000):

| Page | What to try |
|---|---|
| `/#movie` | Press **Make movie**. The agents are mocked for now (no Nemotron yet), but the clips are real Kimodo motion from the GPU, and the windmill is a generated prop. Then press **Play**, scrub the timeline, and try **Export WebM**. |
| `/#chat` | Talk to Mira. Replies are mocked for now. Try "show me a squat" or "teach me a jumping jack": these generate real motion. |
| `/props.html` | Every library prop at real-world scale, plus the generated windmill. |
| `/characters.html` | One VRM playing walk → wave, with an IK toggle and foot markers. Check whether the feet slide. |

---

## Notes

<!-- One bullet per thing. Say what you saw and what you want instead. -->

### Round 1 (2026-11-07, night): all turned into tasks 13–21 in TASKS.md
- Character and object sizes don't match → 14
- Positions don't match → 14
- World generation leaves most of the area empty, and the background looks bad; it should be full like the beach/forest reference → 15
- Needs film-like camera work: cuts and angle changes (close, far, side) → 16
- Edit mode for the world: select, move, duplicate, replace, regenerate items → 18
- Draw a camera path from one timestamp to another, like directing your own movie → 19
- Remove the default canned chat texts ("Hi", "I can show you a squat") → 13
- Day/night and weather changes (see the day/night city reference) → 17
- Paint-over technique (blocks → AI paints over a screenshot → project it back; also works for interiors) → Later (backdrop only, in 15)

-

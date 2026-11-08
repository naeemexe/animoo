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

### Round 2 (2026-11-08, 01:45): turned into tasks 22–27 in TASKS.md
- Generate characters from the story instead of the two built-in models → 27
- Blur looks random, not intentional → 23
- Objects are too blocky → 23
- ElevenLabs voices for cinematic lines the characters speak → 26
- Not only forest: test city, sea, park → 24
- The world is a limited circular area → 23
- Character heights are too different → 22
- Characters pass through the bench instead of going around it; control position, don't let clips move them → 22
- Interactions face the wrong way (says hi while the girl is on the other side; looks somewhere else instead of at the boy); pointing needs a direction → 22
- Shadows jitter → 23
- 2D outlines on small items are too thick → 23
- Standing up from the ground is too fast → 22
- Game-style action library (walk, jump, talk, wave, dig, build, pick up, punch, kick, crouch walk) reused everywhere; generate only unusual moves (push-ups, moonwalk) → 22
- Interior scenes (room, restaurant) with an inside camera that moves horizontally, two-shots, from behind one character → 25

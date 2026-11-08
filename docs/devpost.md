# Animoo: Devpost submission

**Tracks to enter:** Nvidia: *Use Nemotron Beyond a Chatbot* (company track), plus the general **Design** and
**Virality** tracks. None of the other company challenges (fraud, finance, data centers, oil fields…) fit this
project, and judges reward a sharp fit over a stretch, so enter just the one company track.

**MLH prizes to enter:** **Best Use of ElevenLabs** (each new scene gets an ElevenLabs sound-effects ambience loop,
cached in `library/audio/`, and Milo in Chat speaks his replies through ElevenLabs text-to-speech) and **Best Use of
Gen AI** (the whole film is generated: Nemotron plans, SANA + TRELLIS.2 make missing props, Kimodo makes motion).
Optional after the deadline: the **DEV Writing Challenge** (publish a post about the build).

---

## Name
Animoo

## Tagline (one line)
Type a sentence, get a living animated film: Nemotron agents plan the story, build the world, direct the cast and the camera, and the film changes live when you say "make it night".

## Inspiration
Game engines let a player drive characters with a controller. We wanted the same control with plain words: describe a scene the way you'd tell a friend, and a team of agents turns it into a short animated film you can keep changing while it plays.

## What it does
- **Prompt → film:** "two friends walking beside the sea, then they stop and talk." In about 10–25 s you get a 3D storybook film: a set (beach, city, park, forest, rooms), the cast in matching outfits, motion, camera work, ambient sound and music.
- **The orchestrator directs like a game:** each beat is a command: who walks from where to where, who walks beside whom, who sits, waves, nods, fist-bumps or leaves. Moves come from a library of motion clips, like a game's animation set. The text-to-motion model (Kimodo) generates a clip only when a move is outside that library, and every generated clip is cached.
- **Live changes:** "make it night", "make it winter", "back to day" relight the running film in milliseconds (0 LLM calls). "Now they dance" asks Nemotron to revise only that part.
- **Multi-part stories:** "then they go inside to their room and sit down" adds Part 2 with a new set and the same characters, and the film plays straight through.
- **Director camera:** shots are cut by rules, like an editor would: establishing shots, front and side tracking of walkers, over-the-shoulder shots for talk, and no jump cuts.
- **Chat mode:** talk to Milo, a 3D character who answers with Nemotron and acts out the move you ask for.

## How we built it (Nemotron beyond a chatbot)
A multi-step agent pipeline in which Nemotron calls tools and its JSON output drives the whole film:
1. **Orchestrator** (Nemotron 3.5 Super): scene → plan JSON (cast with looks, places, command beats, audio), repaired and validated in code.
2. **World agent** (Nemotron 3.5 Lightning): calls `search_library` per place and picks props, or calls `generate_prop`, which makes a new prop with text → image (SANA) → 3D (TRELLIS.2) on our GPU.
3. **Layout** (code): fits positions, paths, timing and side-by-side walking.
4. **Motion agent:** library clips, or Kimodo text-to-motion for custom moves; VRM retargeting with leg IK and foot planting.
5. **Director:** joins clips, plans walking paths around props and people, and cuts the camera.
6. **Revise agent:** follow-ups edit the cached plan (by rule or one Nemotron call); new places become new film parts.

Stack: FastAPI + SSE (the agent log streams live), three.js + three-vrm, a toon shader with ink outlines, Kimodo / SANA / TRELLIS.2 on an A100, ElevenLabs ambience. Every generation is cached with its prompt, so demos never depend on the GPU.

**ElevenLabs:** the orchestrator writes a sound prompt for each scene (waves and gulls on a beach, traffic in a city,
rain on roofs at night). ElevenLabs sound effects turn it into a seamless 22 s ambience loop that plays under the
film and follows "make it rain" or "make it night". In Chat, Milo's answers are spoken with ElevenLabs TTS, one cached
mp3 per sentence, with the browser voice as a fallback.

## Challenges
- LLM plans are free text; motion needs exact coordinates and timing. We moved the orchestrator to a command vocabulary (library move + move_to / beside / leave) and repair everything in code.
- Making characters behave like game NPCs: walking side by side without stepping in lockstep, stopping exactly where planned, turning to face whoever they talk to, and sitting without sliding onto the chair.
- Live changes without a rebuild: time and weather relight only the sky, lights and weather layers, while the cast, clips and timeline keep playing.

## Accomplishments
- One sentence becomes a multi-part, scored, camera-directed film, with two Nemotron calls per new scene.
- Changing the season or the time of day while the film plays takes about 10 ms.
- A reusable motion library (walk, talk, wave, nod, fist bump, handshake, sit…), with a fallback to text-to-motion generation.

## What we learned
Agents are most reliable when the LLM picks from a vocabulary and code executes it, the way a game engine runs player input.

## What's next
Spoken dialogue for the cast, more motion-library moves, longer stories with more parts, and sharing films as links.

## Built with
nvidia-nemotron, python, fastapi, javascript, three.js, three-vrm, kimodo, trellis, sana, elevenlabs, nvidia-a100

## Links
- Code: https://github.com/naeemexe/animoo
- Demo video: (upload your screen recording of `http://localhost:8000/?demo`)

## Credits
VRM characters by SherryKatzu and Rarestgrass (VRoid, credit required). Props from Kenney (CC0).

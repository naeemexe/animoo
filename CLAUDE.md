# Animo World: rules for every session

Read `PLAN.md`, `TASKS.md` and `WORKFLOW.md` before starting.

- A task session works on exactly **one** task from `TASKS.md`. Commit messages
  start with that task's number, and commits go straight to `main` in small steps.
- Nemotron (hosted, through the NVIDIA API) is the only LLM in the product. The
  track requires it.
- Generated assets are cached in `library/` with their prompt, so a demo
  never depends on the GPU being up.
- The GPU box costs money: $60 total. Start it only for generation work, stop
  it right after, and log the hours in `docs/gpu-log.md`.
- Secrets stay in `.env` only.
- To verify a change, run it, look at it with a screenshot, and read the
  console. Then report what was actually checked.

# Animo World: rules for every session

Read `docs/STATUS.md`, `PLAN.md`, `TASKS.md` and `WORKFLOW.md` before starting.

- A task session works on exactly **one** task from `TASKS.md`. Commit messages
  start with that task's number, and commits go straight to `main` in small steps.
- Nemotron is the only LLM in the product (via `server/llm.py`: OpenCode free tier now, NVIDIA API later). The
  track requires it.
- Generated assets are cached in `library/` with their prompt, so a demo
  never depends on the GPU being up.
- The GPU box (Brev A100, $1.66/hr, from the $60 credit) bills until it is deleted. Log the hours
  in `docs/gpu-log.md` and delete it after the demo.
- Secrets stay in `.env` only.
- To verify a change, run it, look at it with a screenshot, and read the
  console. Then report what was actually checked.

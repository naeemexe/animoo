# Workflow

There are two kinds of Claude session.

**Main session (planning).** This one keeps `TASKS.md` up to date, starts a
session for the next task, checks the finished work, and adds anything new to
the list. It doesn't build features itself.

**Task session (one per task).** It does one task from `TASKS.md`, then you
delete it.

## The loop

1. The main session says which task is next and offers a **session card**.
   You click it.
2. The task session marks the task `doing` and commits that change.
3. It works in **small commits**. Each one is a single step, the project still
   runs after it, and the message starts with the task number, for example
   `03: import kit and write manifest`. It pushes to `main`.
4. It checks the task's "Done when" for real (it runs the page and takes a
   screenshot) and tells you exactly what it checked.
5. It marks the task `done`, and adds anything it noticed but didn't fix to
   **Found along the way**.
6. Back in the main session, the work gets reviewed. You say OK, delete the
   task session, and move on to the next card.

## Rules

- Only one task session runs at a time, so two sessions never edit the same
  files.
- If a task is too big, split it into 05a, 05b and so on in `TASKS.md` first.
- If a task is stuck, the session marks it `waiting`, says why, and stops.
- Research tasks produce a write-up in `docs/research/` and new tasks. They
  don't produce feature code.
- Keys go only in `.env` (gitignored). They never appear in code, commits or
  the browser.
- GPU time gets logged in `docs/gpu-log.md`. Stop the instance when you're done.

# Workflow: one session per task

**Main session (planning).** This session keeps `PLAN.md` and `TASKS.md` up to
date, says which task is next, reviews finished work and adds new findings.
It doesn't build features.

**Task session.** You open a new session for one task. It does that task, then
you close it.

## Starting a task session

Open a new session in this folder and say:

> Do task NN from TASKS.md.

`CLAUDE.md` makes it read the plan, the task list and this file first.

## What a task session does

1. Sets its task to `doing` in `TASKS.md` and commits that.
2. Works in **small commits** prefixed with the task number, for example
   `04: copy VRMs into library/characters`. Each commit leaves the app running.
   It stages files by explicit path, because another session may be committing
   in the same folder.
3. Checks the task's "Done when" for real: it runs the app, looks at a
   screenshot and reads the console. Then it reports exactly what it checked.
4. Sets the task to `done` and adds anything it noticed but didn't fix to
   **Found along the way**.
5. Stops. It never moves on to the next task.

## Closing it

Come back to the main session and say "task NN is done". The main session
reviews the commits against "Done when" and updates the plan. Then you close or
delete the task session and open the next one.

## Rules

- At most one task session per track (A app, B GPU) at a time, so two sessions
  never edit the same files.
- If a task is too big, split it in `TASKS.md` first (09a, 09b and so on).
- If a task is stuck, the session marks it `waiting`, says why, and stops.
- Keys live only in `.env` (gitignored). Sessions never read them out, print
  them, or commit them.
- The pod costs money: log GPU hours in `docs/gpu-log.md`, and stop the pod when
  nothing is generating.

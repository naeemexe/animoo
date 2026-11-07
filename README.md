# Animo World

Two pages, one storybook 3D world:

- **Chat:** a character talks with you, and can show you a move when you ask.
- **Movie:** describe a longer scene. A team of Nemotron agents breaks it into
  short shots, builds the world (generating any props it lacks), animates each
  character clip by clip, and merges everything into one film you can export.

```
"At sunrise an old fisherman walks out of his hut, stretches, waves at a kid
 running past the well, and then they both sit on the dock."
```

Built for the **NVIDIA Nemotron prize track**, "Use Nemotron beyond a chatbot".

- [PLAN.md](PLAN.md): the product, agents, architecture and models.
- [TASKS.md](TASKS.md): the task list. One Claude session per task.
- [WORKFLOW.md](WORKFLOW.md): how to start and close a task session.
- [docs/gpu-log.md](docs/gpu-log.md): the RunPod GPU box, servers and costs.

## Run

```bash
python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt
cp .env.example .env          # then add NVIDIA_API_KEY
server/.venv/bin/uvicorn server.app:app --port 8000   # serves web/ at http://localhost:8000
bash gpu/tunnel.sh            # in another terminal: GPU servers on :8101 / :8102
```

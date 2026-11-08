#!/usr/bin/env bash
# Start / stop / check the GPU servers. Copy gpu/ to /opt/app first.
#   bash /opt/app/serve.sh start [motion|asset|image|llm]   # default: all
#   bash /opt/app/serve.sh stop  [motion|asset|image|llm]
#   bash /opt/app/serve.sh status
# Logs: /workspace/logs/<name>.log   PIDs: /tmp/<name>.pid
#
# llm = self-hosted Nemotron (vLLM, OpenAI-compatible API on :8104). No key and no
# rate limit; the app uses it with LLM_BACKEND=openai, NEMOTRON_BASE_URL=http://localhost:8104/v1.
export HF_HOME=/workspace/hf
cd "$(dirname "$0")"

declare -A VENV=([motion]=kimodo [asset]=trellis [image]=image [llm]=vllm)
declare -A PORT=([motion]=8101 [asset]=8102 [image]=8103 [llm]=8104)
LLM_MODEL=${LLM_MODEL:-nvidia/NVIDIA-Nemotron-Nano-9B-v2}

start() {
  local s=$1
  if [ -f /tmp/$s.pid ] && kill -0 "$(cat /tmp/$s.pid)" 2>/dev/null; then echo "$s already running"; return; fi
  if [ "$s" = llm ]; then
    setsid nohup /opt/venvs/vllm/bin/vllm serve "$LLM_MODEL" --served-model-name nemotron \
      --host 127.0.0.1 --port ${PORT[llm]} --trust-remote-code --mamba_ssm_cache_dtype float32 \
      --max-model-len 32768 --gpu-memory-utilization 0.40 \
      > /workspace/logs/llm.log 2>&1 < /dev/null &
  else
    setsid nohup /opt/venvs/${VENV[$s]}/bin/uvicorn ${s}_server:app --host 127.0.0.1 --port ${PORT[$s]} \
      > /workspace/logs/$s.log 2>&1 < /dev/null &
  fi
  echo $! > /tmp/$s.pid
  echo "$s starting (pid $!, port ${PORT[$s]})"
}

stop() {
  local s=$1
  [ -f /tmp/$s.pid ] && kill "$(cat /tmp/$s.pid)" 2>/dev/null && echo "$s stopped"
  rm -f /tmp/$s.pid
}

status() {
  for s in motion asset image; do
    printf "%-7s " $s; curl -s -m 3 localhost:${PORT[$s]}/health || printf "down"; echo
  done
  printf "%-7s " llm; curl -s -m 3 localhost:${PORT[llm]}/v1/models | head -c 120 || printf "down"; echo
}

mkdir -p /workspace/logs
cmd=${1:-status}; shift || true
targets=${*:-motion asset image llm}
case $cmd in
  start)  for s in $targets; do start $s; done ;;
  stop)   for s in $targets; do stop $s; done ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status [motion|asset|image|llm]"; exit 1 ;;
esac

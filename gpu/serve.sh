#!/usr/bin/env bash
# Start / stop / check the GPU servers on the pod. Copy gpu/ to /opt/app first.
#   bash /opt/app/serve.sh start [motion|asset]   # default: both
#   bash /opt/app/serve.sh stop  [motion|asset]
#   bash /opt/app/serve.sh status
# Logs: /workspace/logs/{motion,asset}.log   PIDs: /tmp/{motion,asset}.pid
export HF_HOME=/workspace/hf
cd "$(dirname "$0")"

declare -A VENV=([motion]=kimodo [asset]=trellis)
declare -A PORT=([motion]=8101 [asset]=8102)

start() {
  local s=$1
  if [ -f /tmp/$s.pid ] && kill -0 "$(cat /tmp/$s.pid)" 2>/dev/null; then echo "$s already running"; return; fi
  setsid nohup /opt/venvs/${VENV[$s]}/bin/uvicorn ${s}_server:app --host 127.0.0.1 --port ${PORT[$s]} \
    > /workspace/logs/$s.log 2>&1 < /dev/null &
  echo $! > /tmp/$s.pid
  echo "$s starting (pid $!, port ${PORT[$s]})"
}

stop() {
  local s=$1
  [ -f /tmp/$s.pid ] && kill "$(cat /tmp/$s.pid)" 2>/dev/null && echo "$s stopped"
  rm -f /tmp/$s.pid
}

status() {
  for s in motion asset; do
    printf "%-7s " $s; curl -s -m 3 localhost:${PORT[$s]}/health || printf "down"; echo
  done
}

mkdir -p /workspace/logs
cmd=${1:-status}; shift || true
targets=${*:-motion asset}
case $cmd in
  start)  for s in $targets; do start $s; done ;;
  stop)   for s in $targets; do stop $s; done ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status [motion|asset]"; exit 1 ;;
esac

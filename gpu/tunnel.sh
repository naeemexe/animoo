#!/usr/bin/env bash
# Forward the GPU servers to this laptop:
#   motion server → http://localhost:8101,  asset server → http://localhost:8102,
#   image server  → http://localhost:8103
# The pod's SSH port changes whenever it resets, so check RunPod → Connect.
#   GPU_SSH_PORT=22149 bash gpu/tunnel.sh
HOST=${GPU_SSH_HOST:-194.68.245.46}
PORT=${GPU_SSH_PORT:-22149}
exec ssh -N -o ServerAliveInterval=30 -i ~/.ssh/id_ed25519 -p "$PORT" \
  -L 8101:127.0.0.1:8101 -L 8102:127.0.0.1:8102 -L 8103:127.0.0.1:8103 "root@$HOST"

#!/usr/bin/env bash
# Forward the GPU servers to this laptop:
#   motion → http://localhost:8101   asset → http://localhost:8102   image → http://localhost:8103   llm → http://localhost:8104/v1
#
# Default: the Brev A100 (`framed-gpu`, an SSH alias that `brev refresh` writes).
#   bash gpu/tunnel.sh
# Any other box: GPU_SSH="root@HOST -p PORT -i ~/.ssh/id_ed25519" bash gpu/tunnel.sh
TARGET=${GPU_SSH:-framed-gpu}
# shellcheck disable=SC2086
exec ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -L 8101:127.0.0.1:8101 -L 8102:127.0.0.1:8102 -L 8103:127.0.0.1:8103 -L 8104:127.0.0.1:8104 $TARGET

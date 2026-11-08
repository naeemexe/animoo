#!/usr/bin/env bash
# Set up the GPU box: TRELLIS.2 (image -> 3D), Kimodo (text -> motion) and
# SANA-Sprint (text -> concept image).
#
# Safe to re-run. The container disk (/) is wiped on every pod reset; the
# volume (/workspace) is not. So code + venvs live on / and are rebuilt by this
# script, while model weights and compiled wheels live on /workspace and are
# reused, which makes a re-run after a reset much faster.
#
#   bash gpu/setup.sh            # everything
#   bash gpu/setup.sh trellis    # one part
#   bash gpu/setup.sh kimodo
#   bash gpu/setup.sh image
set -euo pipefail

# Bare VMs (Brev) have no /workspace, no torch and no nvcc. Bootstrap them so
# every path below is the same as on the RunPod image.
bootstrap() {
  local SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
  $SUDO mkdir -p /workspace /opt/venvs /opt/src /opt/app
  $SUDO chown -R "$(id -u):$(id -g)" /workspace /opt/venvs /opt/src /opt/app
  if ! command -v nvcc >/dev/null && [ ! -x /usr/local/cuda/bin/nvcc ]; then
    echo "=== installing CUDA 12.8 toolkit ==="
    $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      cuda-toolkit-12-8 python3-venv python3-dev build-essential git
  fi
  if ! command -v cmake >/dev/null || ! command -v g++ >/dev/null; then
    $SUDO apt-get install -y -qq g++ g++-12 build-essential cmake ninja-build libgl1 libglib2.0-0 ffmpeg
  fi
  if ! python3 -c "import torch" 2>/dev/null; then
    echo "=== installing torch 2.8 (cu128) system-wide ==="
    $SUDO python3 -m pip install -q torch==2.8.0 torchvision==0.23.0 \
      --index-url https://download.pytorch.org/whl/cu128
  fi
}
bootstrap

export HF_HOME=/workspace/hf                  # HF login + model weights persist here
export PIP_CACHE_DIR=/workspace/pip-cache
WHEELS=/workspace/wheels                      # compiled CUDA extensions, built once
export CUDA_HOME=$( [ -d /usr/local/cuda-12.8 ] && echo /usr/local/cuda-12.8 || echo /usr/local/cuda )
export PATH="$CUDA_HOME/bin:$PATH"
# Compile CUDA extensions for whatever GPU this is (8.0 A100, 8.6 A40, 8.9 L40S, 9.0 H100).
export TORCH_CUDA_ARCH_LIST="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1)"
# Some images point gcc at a version whose C++ compiler isn't installed; use a
# matching gcc/g++ pair for every compiler, nvcc included.
if command -v g++-11 >/dev/null && [ ! -x "/usr/lib/gcc/x86_64-linux-gnu/$(gcc -dumpversion | cut -d. -f1)/cc1plus" ]; then
  export CC=gcc-11 CXX=g++-11 CUDAHOSTCXX=g++-11 NVCC_PREPEND_FLAGS="-ccbin /usr/bin/g++-11"
fi
export MAX_JOBS=${MAX_JOBS:-$(( $(nproc) > 16 ? 16 : $(nproc) ))}
mkdir -p "$WHEELS" /opt/venvs /opt/src

PART=${1:-all}
log() { echo -e "\n=== $* ==="; }

clone() {  # clone <url> <dir> [git args...]
  local url=$1 dir=$2; shift 2
  [ -d "$dir/.git" ] || git clone -q --depth 1 "$@" "$url" "$dir"
}

# Build a wheel once into /workspace/wheels, then install it from there.
wheel_install() {  # wheel_install <venv> <key> <source>
  local venv=$1 key=$2 src=$3 dir="$WHEELS/$2"
  # pip can't write wheels straight onto the volume (it's a FUSE store that
  # rejects chmod), so build on local disk and copy the bytes over. Each
  # extension gets its own folder because wheel names don't match repo names.
  if ! ls "$dir"/*.whl >/dev/null 2>&1; then
    log "building $key (first time only)"
    rm -rf /tmp/wheels-build && mkdir -p /tmp/wheels-build "$dir"
    "$venv/bin/pip" wheel --no-deps --no-build-isolation -w /tmp/wheels-build "$src"
    for w in /tmp/wheels-build/*.whl; do cat "$w" > "$dir/$(basename "$w")"; done
  fi
  "$venv/bin/pip" install -q --no-deps "$dir"/*.whl
}

setup_trellis() {
  local V=/opt/venvs/trellis
  log "TRELLIS.2 venv"
  [ -d $V ] || python3 -m venv --system-site-packages $V    # reuse the image's torch 2.8 + cu128
  clone https://github.com/microsoft/TRELLIS.2.git /opt/src/TRELLIS.2 --recursive
  $V/bin/pip install -q -U pip wheel setuptools ninja
  $V/bin/pip install -q imageio imageio-ffmpeg tqdm easydict opencv-python-headless trimesh \
      "transformers==4.57.1" pandas zstandard kornia timm pillow fastapi "uvicorn[standard]" python-multipart
  $V/bin/pip install -q "git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8"

  log "attention backend"
  if ! $V/bin/python -c "import flash_attn" 2>/dev/null; then
    # flash-attn ships prebuilt wheels for torch 2.8; fall back to xformers if not.
    $V/bin/pip install -q flash-attn==2.8.3 --no-build-isolation || \
      $V/bin/pip install -q xformers==0.0.32.post2
  fi

  clone https://github.com/NVlabs/nvdiffrast.git /opt/src/nvdiffrast -b v0.4.0
  clone https://github.com/JeffreyXiang/nvdiffrec.git /opt/src/nvdiffrec -b renderutils
  clone https://github.com/JeffreyXiang/CuMesh.git /opt/src/CuMesh --recursive
  clone https://github.com/JeffreyXiang/FlexGEMM.git /opt/src/FlexGEMM --recursive
  wheel_install $V nvdiffrast /opt/src/nvdiffrast
  wheel_install $V renderutils /opt/src/nvdiffrec
  wheel_install $V cumesh /opt/src/CuMesh
  wheel_install $V flex_gemm /opt/src/FlexGEMM
  wheel_install $V o_voxel /opt/src/TRELLIS.2/o-voxel

  log "TRELLIS.2 weights"
  $V/bin/hf download microsoft/TRELLIS.2-4B >/dev/null 2>&1 || \
    $V/bin/python -c "from huggingface_hub import snapshot_download as s; s('microsoft/TRELLIS.2-4B')"
  log "TRELLIS.2 ready"
}

setup_kimodo() {
  local V=/opt/venvs/kimodo
  log "Kimodo venv"
  [ -d $V ] || python3 -m venv --system-site-packages $V
  clone https://github.com/nv-tlabs/kimodo.git /opt/src/kimodo
  $V/bin/pip install -q -U pip wheel setuptools
  $V/bin/pip install -q -e "/opt/src/kimodo[all]" fastapi "uvicorn[standard]"
  log "Kimodo ready (weights download on first load)"
}

setup_image() {
  local V=/opt/venvs/image
  log "SANA-Sprint venv"
  [ -d $V ] || python3 -m venv --system-site-packages $V    # reuse the image's torch 2.8 + cu128
  $V/bin/pip install -q -U pip wheel setuptools
  $V/bin/pip install -q "diffusers==0.35.2" "transformers==4.57.1" accelerate sentencepiece \
      protobuf pillow fastapi "uvicorn[standard]" httpx
  log "SANA-Sprint weights (Apache-2.0; text encoder is Gemma-2-2B-IT, Gemma Terms of Use)"
  $V/bin/python -c "from huggingface_hub import snapshot_download as s; s('${SANA_MODEL:-Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers}')"
  log "SANA-Sprint ready"
}

setup_llm() {
  local V=/opt/venvs/vllm
  log "vLLM + Nemotron Nano 9B v2 (self-hosted, no key, no rate limit)"
  [ -d $V ] || python3 -m venv $V
  $V/bin/pip install -q -U pip && $V/bin/pip install -q vllm
  $V/bin/python -c "from huggingface_hub import snapshot_download as s; s('nvidia/NVIDIA-Nemotron-Nano-9B-v2')"
  log "Nemotron ready (bash serve.sh start llm)"
}

case $PART in
  trellis) setup_trellis ;;
  kimodo)  setup_kimodo ;;
  image)   setup_image ;;
  llm)     setup_llm ;;
  all)     setup_kimodo; setup_trellis; setup_image ;;
  *) echo "usage: $0 [all|trellis|kimodo|image]"; exit 1 ;;
esac

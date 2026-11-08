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

export HF_HOME=/workspace/hf                  # HF login + model weights persist here
export PIP_CACHE_DIR=/workspace/pip-cache
WHEELS=/workspace/wheels                      # compiled CUDA extensions, built once
export CUDA_HOME=/usr/local/cuda
export TORCH_CUDA_ARCH_LIST="8.6"             # A40. Use "8.0" for A100, "8.9" for L40S/4090.
export MAX_JOBS=${MAX_JOBS:-8}
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
    rm -rf /opt/wheels-build && mkdir -p /opt/wheels-build "$dir"
    "$venv/bin/pip" wheel --no-deps --no-build-isolation -w /opt/wheels-build "$src"
    for w in /opt/wheels-build/*.whl; do cat "$w" > "$dir/$(basename "$w")"; done
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

case $PART in
  trellis) setup_trellis ;;
  kimodo)  setup_kimodo ;;
  image)   setup_image ;;
  all)     setup_kimodo; setup_trellis; setup_image ;;
  *) echo "usage: $0 [all|trellis|kimodo|image]"; exit 1 ;;
esac

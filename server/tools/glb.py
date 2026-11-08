"""Normalize a generated GLB: trim the ground slab, pivot at bottom-center, scale.

TRELLIS.2 exports one textured triangle mesh (trimesh writer, identity node
transforms, non-interleaved buffers), centered on the origin in a unit cube.
The concept images usually stand the object on a small grass disc or stone
slab, and TRELLIS keeps it. `normalize_glb()` finds that slab from the mesh's
silhouette (a thin bottom band clearly wider than the body above it), drops
its triangles, then moves the rest so it stands on y = 0, centered on x/z, at
`height_m` tall. It only needs numpy; anything it can't handle safely is
returned unchanged, because the browser's loader normalizes pivot and scale
anyway (only the trim is lost).
"""

from __future__ import annotations

import json
import struct

import numpy as np

GLB_MAGIC, JSON_CHUNK, BIN_CHUNK = 0x46546C67, 0x4E4F534A, 0x004E4942
COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(data: bytes) -> tuple[dict, bytes]:
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError("not a GLB file")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    if jtype != JSON_CHUNK:
        raise ValueError("GLB has no JSON chunk")
    doc = json.loads(data[20:20 + jlen])
    pos = 20 + jlen
    blob = b""
    if pos < len(data):
        blen, btype = struct.unpack_from("<II", data, pos)
        if btype == BIN_CHUNK:
            blob = data[pos + 8:pos + 8 + blen]
    return doc, blob


def write_glb(doc: dict, blob: bytes) -> bytes:
    j = json.dumps(doc, separators=(",", ":")).encode()
    j += b" " * (-len(j) % 4)
    blob += b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(j) + 8 + len(blob)
    return (struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(j), JSON_CHUNK) + j
            + struct.pack("<II", len(blob), BIN_CHUNK) + blob)


def _read(doc: dict, blob: bytes, index: int) -> np.ndarray:
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    if view.get("byteStride") or acc.get("sparse") or acc.get("normalized"):
        raise ValueError("interleaved, sparse or normalized accessors are not handled")
    n = WIDTH[acc["type"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    a = np.frombuffer(blob, COMPONENT[acc["componentType"]], acc["count"] * n, start)
    return a.reshape(-1, n) if n > 1 else a


def find_base(P: np.ndarray, F: np.ndarray) -> float | None:
    """Height (model units) of the top of a ground slab, or None if there isn't one.

    The footprint radius (95th percentile, around the body's axis) is measured
    in 1 % height bands. The body's reference radius is the median band 15-25 %
    up, just above where slabs end, so a flared or conical body (a windmill
    tower) isn't mistaken for one. A slab is a bottom band at least 1.25x that
    wide; its top is the first band, going up, back within 1.12x. It must end
    by 18 % of the height, or the wide part is probably the object itself.
    """
    y = P[:, 1]
    y0, h = float(y.min()), float(np.ptp(y))
    if h <= 0:
        return None
    t = (y - y0) / h
    ref = (t >= 0.15) & (t < 0.25)
    if ref.sum() < 50:
        return None
    cx, cz = np.median(P[ref, 0]), np.median(P[ref, 2])
    r = np.hypot(P[:, 0] - cx, P[:, 2] - cz)
    radii = []
    for k in range(25):
        s = (t >= k * 0.01) & (t < (k + 1) * 0.01)
        radii.append(float(np.percentile(r[s], 95)) if s.sum() >= 10 else 0.0)
    ref_r = [x for x in radii[15:25] if x > 0]
    if not ref_r:
        return None
    r_body = float(np.median(ref_r))
    if max(radii[:4]) < 1.25 * r_body:  # nothing wide at the very bottom
        return None
    for k, rk in enumerate(radii[:19]):
        if 0 < rk <= 1.12 * r_body:
            return y0 + k * 0.01 * h
    return None


def normalize_glb(data: bytes, height_m: float, trim_base: bool = True) -> tuple[bytes, dict]:
    """Returns (glb bytes, info). info has size [w, h, d] in meters and what was trimmed."""
    doc, blob = read_glb(data)
    meshes, nodes = doc.get("meshes", []), doc.get("nodes", [])
    info: dict = {"normalized": False, "trimmed": False}
    if len(meshes) != 1 or len(meshes[0]["primitives"]) != 1 or any(
            k in n for n in nodes for k in ("matrix", "rotation", "scale", "translation")):
        info["reason"] = "not a single untransformed mesh"
        return data, info
    prim = meshes[0]["primitives"][0]
    if prim.get("mode", 4) != 4 or "indices" not in prim or "targets" in prim:
        info["reason"] = "not an indexed triangle list"
        return data, info

    attrs = {name: _read(doc, blob, i).copy() for name, i in prim["attributes"].items()}
    F = _read(doc, blob, prim["indices"]).astype(np.uint32).reshape(-1, 3)
    P = attrs["POSITION"].astype(np.float64)

    if trim_base:
        cut = find_base(P, F)
        if cut is not None:
            keep = P[F, 1].mean(axis=1) >= cut  # triangle centroid above the slab top
            if 0.5 < keep.mean() < 1.0:
                info.update(trimmed=True, cut_fraction=round(float((cut - P[:, 1].min()) / np.ptp(P[:, 1])), 3),
                            triangles_removed=int((~keep).sum()))
                F = F[keep]
                used = np.unique(F)  # drop orphaned vertices so bounds match the mesh
                remap = np.zeros(len(P), np.uint32)
                remap[used] = np.arange(len(used), dtype=np.uint32)
                F = remap[F]
                attrs = {k: v[used] for k, v in attrs.items()}
                P = P[used]

    lo, hi = P.min(axis=0), P.max(axis=0)
    s = height_m / (hi[1] - lo[1])
    P = (P - [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]) * s  # normals survive uniform scale
    attrs["POSITION"] = P.astype(np.float32)
    size = [round(float(v), 2) for v in (hi - lo) * s]

    # Rebuild the buffer: the primitive's accessors get fresh views, other
    # views (textures) are copied as they are.
    new_views, chunks, offset = [], [], 0

    def add(raw: bytes, target: int | None = None) -> int:
        nonlocal offset
        pad = -offset % 4
        chunks.append(b"\0" * pad)
        offset += pad
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(raw)}
        if target:
            view["target"] = target
        chunks.append(raw)
        offset += len(raw)
        new_views.append(view)
        return len(new_views) - 1

    prim_accessors = set(prim["attributes"].values()) | {prim["indices"]}
    prim_views = {doc["accessors"][i]["bufferView"] for i in prim_accessors}
    if any(a.get("bufferView") in prim_views for i, a in enumerate(doc["accessors"]) if i not in prim_accessors):
        info["reason"] = "mesh buffer views are shared"
        return data, info
    view_map = {}
    for vi, view in enumerate(doc["bufferViews"]):
        if vi in prim_views:
            continue
        start = view.get("byteOffset", 0)
        nv = add(blob[start:start + view["byteLength"]], view.get("target"))
        new_views[nv].update({k: v for k, v in view.items() if k not in ("buffer", "byteOffset", "byteLength")})
        view_map[vi] = nv

    def put(acc_index: int, arr: np.ndarray, target: int) -> None:
        acc = doc["accessors"][acc_index]
        arr = np.ascontiguousarray(arr.astype(COMPONENT[acc["componentType"]]))
        acc["bufferView"] = add(arr.tobytes(), target)
        acc.pop("byteOffset", None)
        acc["count"] = int(arr.shape[0]) if arr.ndim > 1 else int(arr.size)
        flat = arr.reshape(acc["count"], -1)
        acc["min"] = [x.item() for x in flat.min(axis=0)]
        acc["max"] = [x.item() for x in flat.max(axis=0)]

    if len(attrs["POSITION"]) > 65535:
        doc["accessors"][prim["indices"]]["componentType"] = 5125
    put(prim["indices"], F.reshape(-1), 34963)
    for name, i in prim["attributes"].items():
        put(i, attrs[name], 34962)
    for i, acc in enumerate(doc["accessors"]):
        if i not in prim_accessors and "bufferView" in acc:
            acc["bufferView"] = view_map[acc["bufferView"]]
    for img in doc.get("images", []):
        if "bufferView" in img:
            img["bufferView"] = view_map[img["bufferView"]]
    doc["bufferViews"] = new_views
    blob = b"".join(chunks)
    doc["buffers"] = [{"byteLength": len(blob)}]
    info.update(normalized=True, size=size, vertices=len(P), triangles=len(F))
    return write_glb(doc, blob), info

#!/usr/bin/env python3
"""Bake land-cover classification from Esri World Imagery (z14) for archipelago islands.

Output: public/archipelago_cover.json
Classes: 0 none/water, 1 forest, 2 field/grass, 3 rock/bare, 4 heath/scrub.
"""
import base64
import io
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_JSON = os.path.join(ROOT, "public", "archipelago_map.json")
OUT_JSON = os.path.join(ROOT, "public", "archipelago_cover.json")
CACHE = "/private/tmp/claude-501/-Users-alvinjobb-Projects-github-portfolio/88c16174-e79a-426d-a54a-ecf150c78848/scratchpad/esri14"
Z = 14
N = 2 ** Z
TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"

LON0, LAT0 = 21.49, 59.805
KX = 111320 * math.cos(math.radians(59.805))  # 55987.8
KZ = 111320.0

os.makedirs(CACHE, exist_ok=True)
_tiles = {}


def world_to_lonlat(x, z):
    return LON0 + x / KX, LAT0 - z / KZ


def lonlat_to_tilef(lon, lat):
    xt = (lon + 180.0) / 360.0 * N
    yt = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * N
    return xt, yt


def get_tile(tx, ty):
    key = (tx, ty)
    if key in _tiles:
        return _tiles[key]
    path = os.path.join(CACHE, f"{tx}_{ty}.jpg")
    if not os.path.exists(path):
        url = TILE_URL.format(z=Z, y=ty, x=tx)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=30) as r:
                    data = r.read()
                with open(path, "wb") as f:
                    f.write(data)
                time.sleep(0.05)
                break
            except Exception as e:
                if attempt == 3:
                    raise
                time.sleep(1.0 + attempt)
    arr = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    _tiles[key] = arr
    if len(_tiles) > 600:  # keep memory bounded
        _tiles.pop(next(iter(_tiles)))
    return arr


def sample_rgb(lon, lat):
    """Mean RGB of a 3x3 pixel block at lon/lat."""
    xt, yt = lonlat_to_tilef(lon, lat)
    px, py = xt * 256.0, yt * 256.0
    ipx, ipy = int(px), int(py)
    acc = np.zeros(3, dtype=np.float64)
    cnt = 0
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            gx, gy = ipx + dx, ipy + dy
            tx, ty = gx // 256, gy // 256
            arr = get_tile(tx, ty)
            acc += arr[gy % 256, gx % 256]
            cnt += 1
    return acc / cnt


def rgb_to_hsv(rgb):
    r, g, b = rgb / 255.0
    mx, mn = max(r, g, b), min(r, g, b)
    v = mx
    d = mx - mn
    s = 0.0 if mx == 0 else d / mx
    if d == 0:
        h = 0.0
    elif mx == r:
        h = (60 * ((g - b) / d)) % 360
    elif mx == g:
        h = 60 * ((b - r) / d) + 120
    else:
        h = 60 * ((r - g) / d) + 240
    return h, s, v


def classify(rgb):
    """Classify one averaged pixel into 0..4."""
    h, s, v = rgb_to_hsv(rgb)
    r, g, b = rgb
    # water: very dark, or dark and blue-dominant
    if v < 0.14 or (b > g and b > r and v < 0.30):
        return 0
    # rock/bare granite & sand: pale, low saturation
    if s < 0.17 and v > 0.30:
        return 3
    if h >= 85:  # true greens
        if v < 0.42:
            if s >= 0.24 and h >= 96:
                return 1  # dark saturated true-green canopy = forest
            return 4      # dull or yellow-leaning green = heath/scrub
        return 2          # bright green = field/grass
    if 60 <= h < 85:  # yellow-green transition
        if v < 0.28 and s > 0.34:
            return 1  # dark saturated = shadowed canopy
        if v > 0.46 and s > 0.25:
            return 2  # bright open grass
        return 4      # heath/scrub
    # h < 60: brown/russet/yellow ground
    if s < 0.20 and v > 0.40:
        return 3
    if v < 0.16:
        return 0
    return 4


def point_in_poly(px, pz, poly_x, poly_z):
    """Vectorized ray cast: px,pz arrays; poly arrays closed implicitly."""
    inside = np.zeros(px.shape, dtype=bool)
    j = len(poly_x) - 1
    for i in range(len(poly_x)):
        xi, zi, xj, zj = poly_x[i], poly_z[i], poly_x[j], poly_z[j]
        cond = (zi > pz) != (zj > pz)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (pz - zi) / (zj - zi) + xi
        inside ^= cond & (px < xint)
        j = i
    return inside


def majority3(grid):
    """3x3 majority filter on class grid (0..4); ties keep centre."""
    nz, nx = grid.shape
    out = grid.copy()
    counts = np.zeros((5, nz, nx), dtype=np.int16)
    for dz in (-1, 0, 1):
        for dx in (-1, 0, 1):
            sh = np.roll(np.roll(grid, dz, axis=0), dx, axis=1)
            # invalidate wrapped edges by clamping later; simple approach:
            for c in range(5):
                counts[c] += (sh == c)
    best = counts.argmax(axis=0)
    bestc = counts.max(axis=0)
    centrec = np.take_along_axis(counts, grid[None].astype(np.int64), axis=0)[0]
    out = np.where(bestc > centrec, best, grid).astype(np.uint8)
    # keep outside-polygon nodes at 0
    out[grid == 0] = np.where(best[grid == 0] != 0, 0, 0)
    out[grid == 0] = 0
    return out


def process_island(isl):
    poly = np.array(isl["p"], dtype=np.float64)
    cx, cz = poly[:, 0].mean(), poly[:, 1].mean()
    lx, lz = poly[:, 0] - cx, poly[:, 1] - cz
    x0, x1 = lx.min() - 0, lx.max()
    z0, z1 = lz.min(), lz.max()
    w, h = x1 - x0, z1 - z0
    step = 12.0
    nx = int(w / step) + 1
    nz = int(h / step) + 1
    if nx > 96 or nz > 96:
        step = max(w / 95.0, h / 95.0, 12.0)
        nx = min(int(w / step) + 1, 96)
        nz = min(int(h / step) + 1, 96)
    nx = max(nx, 2)
    nz = max(nz, 2)
    dx = w / (nx - 1)
    dz = h / (nz - 1)
    gx = x0 + np.arange(nx) * dx
    gz = z0 + np.arange(nz) * dz
    PX, PZ = np.meshgrid(gx, gz)
    inside = point_in_poly(PX, PZ, lx, lz)
    grid = np.zeros((nz, nx), dtype=np.uint8)
    for iz in range(nz):
        for ix in range(nx):
            if not inside[iz, ix]:
                continue
            lon, lat = world_to_lonlat(cx + gx[ix], cz + gz[iz])
            c = classify(sample_rgb(lon, lat))
            grid[iz, ix] = c if c != 0 else 3  # inside land but water-look -> rock shore fallback? keep 0? use 0
    # actually preserve 0 for water-looking inside pixels? use rock for shoreline mixing:
    grid = majority3(grid * inside)  # ensure outside 0
    grid[~inside] = 0
    return dict(cx=cx, cz=cz, x0=float(x0), z0=float(z0), dx=float(dx), dz=float(dz),
                nx=nx, nz=nz, grid=grid, inside=inside)


def fractions(grid, inside):
    n = int(inside.sum())
    if n == 0:
        return {}
    return {c: round(float((grid[inside] == c).sum()) / n, 3) for c in range(5)}


def main():
    data = json.load(open(MAP_JSON))
    islands = data["islands"]
    out = {"meta": "esri z14 land-cover, classes 0none 1forest 2field 3rock 4heath",
           "islands": {}}
    calibrate_only = "--cal" in sys.argv
    named = {isl.get("n"): i for i, isl in enumerate(islands) if isl.get("n")}

    if calibrate_only:
        targets = [named["Jurmo"], named["Nötö"], named["Utö"]]
        # add two unnamed small skerries
        sk = [i for i, isl in enumerate(islands)
              if isl["a"] >= 12000 and isl["a"] < 50000 and not isl.get("n")][:2]
        targets += sk
        for i in targets:
            r = process_island(islands[i])
            f = fractions(r["grid"], r["inside"])
            print(i, islands[i].get("n", "skerry"), islands[i]["a"], f, flush=True)
        return

    n_grid = n_dom = 0
    report = {}
    sk_report = []
    todo = [(i, isl) for i, isl in enumerate(islands) if isl["a"] >= 12000]
    for k, (i, isl) in enumerate(todo):
        r = process_island(isl)
        f = fractions(r["grid"], r["inside"])
        inside = r["inside"]
        if isl["a"] < 40000:
            vals = r["grid"][inside]
            if len(vals):
                dom = int(np.bincount(vals[vals > 0], minlength=5).argmax()) if (vals > 0).any() else 3
            else:
                dom = 3
            out["islands"][str(i)] = {"d": dom}
            n_dom += 1
        else:
            b = base64.b64encode(r["grid"].tobytes()).decode("ascii")
            out["islands"][str(i)] = {
                "x0": round(r["x0"], 1), "z0": round(r["z0"], 1),
                "dx": round(r["dx"], 2), "dz": round(r["dz"], 2),
                "nx": r["nx"], "nz": r["nz"], "b64": b}
            n_grid += 1
        nm = isl.get("n")
        if nm in ("Jurmo", "Utö", "Nötö"):
            report[nm] = f
        elif not nm and isl["a"] < 50000 and len(sk_report) < 2:
            sk_report.append((i, isl["a"], f))
        if k % 100 == 0:
            print(f"{k}/{len(todo)} tiles_cached={len(os.listdir(CACHE))}", flush=True)

    with open(OUT_JSON, "w") as fjs:
        json.dump(out, fjs, separators=(",", ":"))
    size = os.path.getsize(OUT_JSON)
    print(f"processed={len(todo)} grids={n_grid} dominant={n_dom} size={size/1e6:.2f}MB")
    for nm, f in report.items():
        print(nm, f)
    for i, a, f in sk_report:
        print("skerry", i, a, f)


if __name__ == "__main__":
    main()

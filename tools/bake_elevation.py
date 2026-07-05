#!/usr/bin/env python3
"""Bake REAL island elevations into public/archipelago_map.json.

Source: AWS Open Data terrain tiles (Mapzen "terrarium" encoding), which over
Finland derive from the Copernicus EU-DEM (~25 m). Free, no API key.
  https://registry.opendata.aws/terrain-tiles/

Raster tiles are cached OUTSIDE the repo (pass --cache); only tiny per-island
scalars/grids are written into the map JSON:
  e : real max height, decimetres (95th-percentile of interior DEM samples)
  g : coarse height grid for larger islands — {x0,z0,dx,dz,nx,nz,v:[dm...]}
      in LOCAL island coords (same centroid arithmetic as archipelago.js)

Islands too small for the 25 m raster to resolve get NO fields — the runtime
keeps its procedural whaleback and (honestly) reports those as procedural.
This is NOT the 2 m NLS laser DEM; it is coarse but real measured elevation.
"""
import argparse, io, json, math, os, sys, time, urllib.request

import numpy as np
from PIL import Image

LAT0, LON0 = 59.805, 21.49          # bake projection (matches archipelago_map.json)
M_LAT = 111320.0
M_LON = 111320.0 * math.cos(math.radians(LAT0))
Z = 12                              # ~19 m/px ground at 60°N ≈ EU-DEM native
N = 2 ** Z
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

GRID_AREA = 40_000                 # m² — islands above this get a height grid
GRID_STEP_MIN = 45.0                # m — never store nodes denser than this
GRID_MAX_NODES = 440
CLIP_MAX = 80.0                     # m — nothing in the Archipelago Sea is higher
MIN_REAL = 0.5                      # m — below this the DEM can't tell island from sea


def world_to_lonlat(x, z):
    return LON0 + x / M_LON, LAT0 - z / M_LAT


def lonlat_to_px(lon, lat):
    """Global mercator pixel coords at zoom Z (256px tiles)."""
    px = (lon + 180.0) / 360.0 * N * 256
    r = math.radians(lat)
    py = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * N * 256
    return px, py


class Tiles:
    def __init__(self, cache):
        self.cache = cache
        self.tiles = {}
        self.fetched = 0
        os.makedirs(cache, exist_ok=True)

    def tile(self, tx, ty):
        key = (tx, ty)
        if key in self.tiles:
            return self.tiles[key]
        path = os.path.join(self.cache, f"{Z}_{tx}_{ty}.png")
        if not os.path.exists(path):
            url = URL.format(z=Z, x=tx, y=ty)
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(url, timeout=30) as r:
                        data = r.read()
                    with open(path, "wb") as f:
                        f.write(data)
                    self.fetched += 1
                    time.sleep(0.05)
                    break
                except Exception as e:
                    if attempt == 3:
                        raise
                    time.sleep(2.0 * (attempt + 1))
        a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
        elev = a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0 - 32768.0
        self.tiles[key] = elev
        return elev

    def sample_world(self, xs, zs):
        """Nearest-neighbour DEM heights for arrays of world coords (metres)."""
        out = np.empty(len(xs))
        for i, (x, z) in enumerate(zip(xs, zs)):
            lon, lat = world_to_lonlat(x, z)
            px, py = lonlat_to_px(lon, lat)
            tx, ty = int(px // 256), int(py // 256)
            t = self.tile(tx, ty)
            out[i] = t[min(int(py) % 256, 255), min(int(px) % 256, 255)]
        return out


def pip_mask(xs, zs, ring):
    """Vectorised point-in-polygon (crossing test) over point arrays."""
    inside = np.zeros(len(xs), dtype=bool)
    r = np.asarray(ring, dtype=np.float64)
    x1, z1 = r[:, 0], r[:, 1]
    x2, z2 = np.roll(x1, 1), np.roll(z1, 1)
    for i in range(len(r)):
        xi, zi, xj, zj = x1[i], z1[i], x2[i], z2[i]
        cond = (zi > zs) != (zj > zs)
        if not cond.any():
            continue
        xx = (xj - xi) * (zs - zi) / (zj - zi + 1e-12) + xi
        inside ^= cond & (xs < xx)
    return inside


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default="public/archipelago_map.json")
    ap.add_argument("--cache", required=True, help="tile cache dir (keep OUTSIDE the repo)")
    args = ap.parse_args()

    data = json.load(open(args.map))
    tiles = Tiles(args.cache)

    n_e = n_g = 0
    stats = {}
    for rec in data["islands"]:
        pts = np.asarray(rec["p"], dtype=np.float64)
        cx, cz = pts[:, 0].mean(), pts[:, 1].mean()   # same centroid as archipelago.js
        ring = pts - [cx, cz]
        bx0, bz0 = ring[:, 0].min(), ring[:, 1].min()
        bx1, bz1 = ring[:, 0].max(), ring[:, 1].max()
        bw, bd = bx1 - bx0, bz1 - bz0

        # interior sample lattice (local coords), PIP-filtered
        step = float(np.clip(min(bw, bd) / 8.0, 15.0, 60.0))
        gx = np.arange(bx0 + step / 2, bx1, step)
        gz = np.arange(bz0 + step / 2, bz1, step)
        if len(gx) == 0 or len(gz) == 0:
            gx, gz = np.array([(bx0 + bx1) / 2]), np.array([(bz0 + bz1) / 2])
        XX, ZZ = np.meshgrid(gx, gz)
        xs, zs = XX.ravel(), ZZ.ravel()
        m = pip_mask(xs, zs, ring)
        if not m.any():
            # the vertex centroid can sit OUTSIDE a concave ring — never sample sea
            # and call it the island's height; unsampleable islands stay procedural
            if not pip_mask(np.zeros(1), np.zeros(1), ring)[0]:
                rec.pop("e", None); rec.pop("g", None)
                continue
            xs, zs = np.zeros(1), np.zeros(1)
        else:
            xs, zs = xs[m], zs[m]
        h = np.clip(tiles.sample_world(xs + cx, zs + cz), 0.0, CLIP_MAX)
        hmax = float(np.percentile(h, 95))
        if hmax < MIN_REAL:
            rec.pop("e", None); rec.pop("g", None)      # keep re-runs idempotent
            continue                                    # unresolvable → stays procedural

        rec["e"] = int(round(hmax * 10))
        n_e += 1
        if rec.get("n"):
            stats[rec["n"]] = hmax

        # coarse grid for larger islands: real interior relief
        if rec["a"] >= GRID_AREA:
            dx = max(GRID_STEP_MIN, bw / 21.0)
            dz = max(GRID_STEP_MIN, bd / 21.0)
            nx = int(bw / dx) + 2
            nz = int(bd / dz) + 2
            while nx * nz > GRID_MAX_NODES:
                dx *= 1.25; dz *= 1.25
                nx = int(bw / dx) + 2
                nz = int(bd / dz) + 2
            gxs = bx0 + np.arange(nx) * dx
            gzs = bz0 + np.arange(nz) * dz
            GX, GZ = np.meshgrid(gxs, gzs)              # row-major: z rows, x cols
            gv = np.clip(tiles.sample_world(GX.ravel() + cx, GZ.ravel() + cz), 0.0, CLIP_MAX)
            rec["g"] = {
                "x0": round(float(bx0), 1), "z0": round(float(bz0), 1),
                "dx": round(float(dx), 2), "dz": round(float(dz), 2),
                "nx": nx, "nz": nz,
                "v": [int(round(v * 10)) for v in gv],
            }
            rec["e"] = max(rec["e"], int(gv.max() * 10))  # H must cover the terrain
            n_g += 1

    data["elev"] = "per-island heights from AWS terrain tiles (terrarium z12, EU-DEM ~25m); dm units; islands without 'e' are procedural"
    out = json.dumps(data, separators=(",", ":"))
    with open(args.map, "w") as f:
        f.write(out)

    print(f"islands: {len(data['islands'])}  with real e: {n_e}  with grid: {n_g}")
    print(f"tiles fetched: {tiles.fetched}  json size: {len(out)/1e6:.2f} MB")
    for name in ("Jurmo", "Utö", "Nötö", "Aspö", "Berghamn"):
        if name in stats:
            print(f"  {name}: {stats[name]:.1f} m")


if __name__ == "__main__":
    main()

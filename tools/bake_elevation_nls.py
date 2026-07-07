#!/usr/bin/env python3
"""Bake REAL island elevations from the NLS Finland open 10 m DEM.

Source: National Land Survey of Finland (Maanmittauslaitos) open elevation
model 10 m ("korkeusmalli 10 m"), CC BY 4.0, mirrored openly (no auth) at
Paituli/Funet:
  https://www.nic.funet.fi/index/geodata/mml/dem10m/
The mirror ships EPSG:3067 (ETRS-TM35FIN) Float32 GeoTIFF map sheets
(24 x 12 km, 10 m/px) plus a dem10m_direct.vrt master index that gives each
sheet's exact placement — we use the VRT to pick only sheets intersecting
island bounding boxes (+100 m).

Why the 10 m DEM and not the 2 m one: our stored per-island grids sample
every >=25 m anyway (and 'e' is a p95 summary), so 10 m source data is fully
sufficient; the 2 m laser DEM would mean gigabytes of downloads for zero
in-game gain.

Rasters are cached OUTSIDE the repo (pass --cache); only tiny per-island
scalars/grids are written into the map JSON:
  e : real height, decimetres (95th percentile of interior DEM samples,
      raised to the grid max where a grid exists so H covers the terrain)
  g : height grid for islands >= 25,000 m^2 — {x0,z0,dx,dz,nx,nz,v:[dm...]}
      in LOCAL island coords (same centroid arithmetic as archipelago.js)

The 10 m DEM resolves small skerries, so MIN_REAL is 0.3 m; skerries around
the pixel scale whose bilinear p95 still reads as sea get a second pass with
nearest-pixel sampling (a 1-2 px rock keeps its own pixel value instead of a
sea-smeared blend). Islands the DEM still can't tell from sea get e/g popped
(idempotent re-runs) and stay procedural.
"""
import argparse, json, math, os, re, sys, time, urllib.request

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

LAT0, LON0 = 59.805, 21.49          # bake projection (matches archipelago_map.json)
M_LAT = 111320.0
M_LON = 111320.0 * math.cos(math.radians(LAT0))

BASE = "https://www.nic.funet.fi/index/geodata/mml/dem10m/"
VRT = "dem10m_direct.vrt"
SHEET_W, SHEET_H = 24000.0, 12000.0  # m, from the VRT source rects
MOSAIC_E0, MOSAIC_NTOP = 44000.0, 7782000.0  # VRT GeoTransform origin

GRID_AREA = 25_000                  # m^2 — islands above this get a height grid
GRID_STEP_MIN = 25.0                # m — starting node spacing (auto-raised if JSON too big)
GRID_DIV = 26.0                     # dx = max(step_min, bbox/GRID_DIV)
GRID_MAX_NODES = 900
MAX_JSON_MB = 4.5
CLIP_MAX = 80.0                     # m — nothing in the Archipelago Sea is higher
MIN_REAL = 0.3                      # m — 10 m DEM resolves small skerries

CREDIT = ("per-island heights (dm) from NLS Finland open DEM 10 m "
          "(Maanmittauslaitos, CC BY 4.0) via Paituli/Funet; "
          "islands without 'e' are procedural")


def world_to_lonlat(x, z):
    return LON0 + x / M_LON, LAT0 - z / M_LAT


# --- ETRS-TM35FIN (EPSG:3067) forward transform, GRS80, Redfearn/Snyder series.
# Verified against the DEM itself (island interiors land on land, sea on sea);
# series error at delta-lon <= 6 deg, lat 60 N is centimetres — irrelevant vs 10 m px.
_A = 6378137.0
_F = 1 / 298.257222101
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_K0 = 0.9996
_CM = math.radians(27.0)
_FE = 500000.0


def tm35fin(lon, lat):
    """Vectorised WGS84/ETRS89 lon,lat (deg) -> EPSG:3067 E,N (m)."""
    phi = np.radians(lat)
    lam = np.radians(lon) - _CM
    s, c = np.sin(phi), np.cos(phi)
    t2 = (s / c) ** 2
    nu = _A / np.sqrt(1 - _E2 * s * s)
    C = _EP2 * c * c
    Aq = lam * c
    e2 = _E2
    M = _A * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * phi
              - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * phi)
              + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * phi)
              - (35 * e2**3 / 3072) * np.sin(6 * phi))
    E = _FE + _K0 * nu * (Aq + (1 - t2 + C) * Aq**3 / 6
                          + (5 - 18 * t2 + t2 * t2 + 72 * C - 58 * _EP2) * Aq**5 / 120)
    N = _K0 * (M + nu * (s / c) * (Aq**2 / 2 + (5 - t2 + 9 * C + 4 * C * C) * Aq**4 / 24
                                   + (61 - 58 * t2 + t2 * t2 + 600 * C - 330 * _EP2) * Aq**6 / 720))
    return E, N


def fetch(url, dest, tries=3):
    """Small, disciplined downloader: 30 s timeout, retries, no hangs."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = r.read()
            with open(dest, "wb") as f:
                f.write(data)
            time.sleep(0.2)
            return True
        except Exception as e:
            print(f"  fetch {os.path.basename(dest)} attempt {attempt + 1}: {e}", flush=True)
            time.sleep(1.5 * (attempt + 1))
    return False


class Dem:
    """Mosaic of NLS 10 m sheets, indexed by each GeoTIFF's own tiepoint."""

    def __init__(self, cache):
        self.cache = os.path.join(cache, "tif")
        os.makedirs(self.cache, exist_ok=True)
        self.paths = {}     # (kx, ky) sheet-lattice cell -> tif path
        self.arrays = {}    # (kx, ky) -> float32 array (nodata already zeroed)

    @staticmethod
    def cell_of(E, N):
        kx = np.floor((E - MOSAIC_E0) / SHEET_W).astype(np.int64)
        ky = np.floor((MOSAIC_NTOP - N) / SHEET_H).astype(np.int64)
        return kx, ky

    def register(self, path):
        im = Image.open(path)
        tp = im.tag_v2.get(33922)           # ModelTiepointTag -> (.., E0, Ntop, ..)
        E0, Ntop = float(tp[3]), float(tp[4])
        kx = int((E0 - MOSAIC_E0) // SHEET_W)
        ky = int((MOSAIC_NTOP - Ntop) // SHEET_H)
        self.paths[(kx, ky)] = (path, E0, Ntop)

    def ensure_sheets(self, map_islands):
        """Parse the VRT, select sheets intersecting island bboxes (+100 m),
        download any not yet cached, and register everything."""
        vrt_path = os.path.join(self.cache, "..", VRT)
        if not os.path.exists(vrt_path):
            print("fetching VRT index...", flush=True)
            if not fetch(BASE + VRT, vrt_path):
                sys.exit("FATAL: cannot fetch dem10m VRT index")
        vrt = open(vrt_path).read()
        sources = []
        for m in re.finditer(r'<SourceFilename relativeToVRT="1">([^<]+)</SourceFilename>'
                             r'.*?<DstRect xOff="([\d.]+)" yOff="([\d.]+)" xSize="([\d.]+)" ySize="([\d.]+)"',
                             vrt, re.S):
            fn = m.group(1).replace("//", "/")
            xo, yo, xs, ys = (float(v) for v in m.group(2, 3, 4, 5))
            emin = MOSAIC_E0 + xo * 10.0
            nmax = MOSAIC_NTOP - yo * 10.0
            sources.append((fn, emin, nmax - ys * 10.0, emin + xs * 10.0, nmax))

        # union of padded island bboxes in EPSG:3067
        boxes = []
        for rec in map_islands:
            pts = np.asarray(rec["p"], dtype=np.float64)
            xs = np.array([pts[:, 0].min(), pts[:, 0].max()])
            zs = np.array([pts[:, 1].min(), pts[:, 1].max()])
            XX, ZZ = np.meshgrid(xs, zs)
            lon, lat = world_to_lonlat(XX.ravel(), ZZ.ravel())
            E, N = tm35fin(lon, lat)
            boxes.append((E.min() - 100, N.min() - 100, E.max() + 100, N.max() + 100))
        boxes = np.asarray(boxes)

        need = []
        for fn, emin, nmin, emax, nmax in sources:
            hit = ((boxes[:, 0] < emax) & (boxes[:, 2] > emin) &
                   (boxes[:, 1] < nmax) & (boxes[:, 3] > nmin))
            if hit.any():
                need.append(fn)
        print(f"sheets needed: {len(need)}", flush=True)

        fetched = 0
        for fn in need:
            dest = os.path.join(self.cache, os.path.basename(fn))
            if not os.path.exists(dest) or os.path.getsize(dest) == 0:
                print(f"  downloading {os.path.basename(fn)}", flush=True)
                if not fetch(BASE + fn, dest):
                    print(f"  WARNING: sheet {fn} unavailable — its area will read as sea", flush=True)
                    continue
                fetched += 1
            self.register(dest)
        print(f"sheets cached: {len(self.paths)} (downloaded now: {fetched})", flush=True)

    def _array(self, key):
        a = self.arrays.get(key)
        if a is None:
            path, E0, Ntop = self.paths[key]
            a = np.asarray(Image.open(path), dtype=np.float32)
            a = np.nan_to_num(a, nan=0.0)
            a[a <= -100.0] = 0.0            # NoData (-9999) = sea
            self.arrays[key] = a
        return a

    def sample_world(self, xs, zs, nearest=False):
        """DEM heights (m) for arrays of game-world coords (m).

        Bilinear by default; nearest=True returns raw pixel values, which
        matters for 1-2 px skerries that bilinear would smear into the sea."""
        lon, lat = world_to_lonlat(np.asarray(xs, float), np.asarray(zs, float))
        E, N = tm35fin(lon, lat)
        kx, ky = self.cell_of(E, N)
        out = np.zeros(len(E))
        cells = kx * 100000 + ky
        for cid in np.unique(cells):
            m = cells == cid
            key = (int(cid // 100000), int(cid % 100000))
            if key not in self.paths:       # no sheet upstream = open sea
                continue
            _, E0, Ntop = self.paths[key]
            a = self._array(key)
            h, w = a.shape
            fx = np.clip((E[m] - E0) / 10.0 - 0.5, 0.0, w - 1.001)
            fy = np.clip((Ntop - N[m]) / 10.0 - 0.5, 0.0, h - 1.001)
            if nearest:
                out[m] = a[np.rint(fy).astype(int), np.rint(fx).astype(int)]
                continue
            ix, iy = fx.astype(int), fy.astype(int)
            tx, ty = fx - ix, fy - iy
            out[m] = (a[iy, ix] * (1 - tx) * (1 - ty) + a[iy, ix + 1] * tx * (1 - ty)
                      + a[iy + 1, ix] * (1 - tx) * ty + a[iy + 1, ix + 1] * tx * ty)
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


def build_grid(dem, cx, cz, bx0, bz0, bw, bd, step_min):
    dx = max(step_min, bw / GRID_DIV)
    dz = max(step_min, bd / GRID_DIV)
    nx = int(bw / dx) + 2
    nz = int(bd / dz) + 2
    while nx * nz > GRID_MAX_NODES:
        dx *= 1.25; dz *= 1.25
        nx = int(bw / dx) + 2
        nz = int(bd / dz) + 2
    gxs = bx0 + np.arange(nx) * dx
    gzs = bz0 + np.arange(nz) * dz
    GX, GZ = np.meshgrid(gxs, gzs)                    # row-major: z rows, x cols
    gv = np.clip(dem.sample_world(GX.ravel() + cx, GZ.ravel() + cz), 0.0, CLIP_MAX)
    g = {
        "x0": round(float(bx0), 1), "z0": round(float(bz0), 1),
        "dx": round(float(dx), 2), "dz": round(float(dz), 2),
        "nx": nx, "nz": nz,
        "v": [int(round(v * 10)) for v in gv],
    }
    return g, float(gv.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default="public/archipelago_map.json")
    ap.add_argument("--cache", required=True, help="raster cache dir (keep OUTSIDE the repo)")
    args = ap.parse_args()

    data = json.load(open(args.map))
    islands = data["islands"]

    table_names = ("Jurmo", "Utö", "Aspö", "Nötö", "Berghamn")
    biggest = {}
    for rec in islands:
        n = rec.get("n")
        if n in table_names and (n not in biggest or rec["a"] > biggest[n]["a"]):
            biggest[n] = rec
    # several islands are named Berghamn; the sanity target is the outer-
    # archipelago one next to Nötö (the brief lists it among Nötö/Jurmo/Utö)
    if "Nötö" in biggest:
        np_ = np.asarray(biggest["Nötö"]["p"], float)
        ncx, ncz = np_[:, 0].mean(), np_[:, 1].mean()
        cands = [r for r in islands if r.get("n") == "Berghamn"]
        if cands:
            def d2(r):
                p = np.asarray(r["p"], float)
                return (p[:, 0].mean() - ncx) ** 2 + (p[:, 1].mean() - ncz) ** 2
            biggest["Berghamn"] = min(cands, key=d2)
    old_e = {n: biggest[n].get("e") for n in biggest}

    dem = Dem(args.cache)
    dem.ensure_sheets(islands)

    t0 = time.time()
    n_e = 0
    p95_by_id = {}                                    # id(rec) -> p95 before grid-max raise
    grid_specs = []                                   # (rec, cx, cz, bx0, bz0, bw, bd)
    for i, rec in enumerate(islands):
        if i and i % 1000 == 0:
            print(f"  ...{i}/{len(islands)} islands ({time.time() - t0:.0f}s)", flush=True)
        pts = np.asarray(rec["p"], dtype=np.float64)
        cx, cz = pts[:, 0].mean(), pts[:, 1].mean()   # same centroid as archipelago.js
        ring = pts - [cx, cz]
        bx0, bz0 = ring[:, 0].min(), ring[:, 1].min()
        bx1, bz1 = ring[:, 0].max(), ring[:, 1].max()
        bw, bd = bx1 - bx0, bz1 - bz0

        def nearest_max():
            """Tallest DEM pixel inside the ring: a 4 m lattice with
            nearest-pixel sampling reads each rock's own pixel value instead
            of a sea-smeared bilinear blend."""
            g2x = np.arange(bx0, bx1 + 2.0, 4.0)
            g2z = np.arange(bz0, bz1 + 2.0, 4.0)
            X2, Z2 = np.meshgrid(g2x, g2z)
            x2, z2 = X2.ravel(), Z2.ravel()
            m2 = pip_mask(x2, z2, ring)
            if m2.any():
                x2, z2 = x2[m2], z2[m2]
            else:                           # sliver thinner than the lattice:
                x2, z2 = ring[:, 0] * 0.7, ring[:, 1] * 0.7
            h2 = np.clip(dem.sample_world(x2 + cx, z2 + cz, nearest=True), 0.0, CLIP_MAX)
            return float(h2.max())

        if max(bw, bd) <= 80.0:
            # islands only a few DEM pixels across: bilinear p95 blends every
            # sample with the surrounding sea and systematically reads low —
            # for these, "the island's height" IS its tallest mapped pixel
            hmax = nearest_max()
        else:
            # interior sample lattice (local coords), PIP-filtered; the local
            # 10 m mosaic is cheap, so much denser than the old tile bake
            step = float(np.clip(min(bw, bd) / 8.0, 8.0, 20.0))
            gx = np.arange(bx0 + step / 2, bx1, step)
            gz = np.arange(bz0 + step / 2, bz1, step)
            if len(gx) == 0 or len(gz) == 0:
                gx, gz = np.array([(bx0 + bx1) / 2]), np.array([(bz0 + bz1) / 2])
            XX, ZZ = np.meshgrid(gx, gz)
            xs, zs = XX.ravel(), ZZ.ravel()
            m = pip_mask(xs, zs, ring)
            if not m.any():
                # the vertex centroid can sit OUTSIDE a concave ring — never
                # sample sea and call it the island's height
                if pip_mask(np.zeros(1), np.zeros(1), ring)[0]:
                    xs, zs = np.zeros(1), np.zeros(1)
                else:
                    xs = zs = None
            else:
                xs, zs = xs[m], zs[m]
            hmax = 0.0
            if xs is not None:
                h = np.clip(dem.sample_world(xs + cx, zs + cz), 0.0, CLIP_MAX)
                hmax = float(np.percentile(h, 95))
            if hmax < MIN_REAL and max(bw, bd) <= 400.0:
                hmax = nearest_max()        # second chance at native pixels
        if hmax < MIN_REAL:
            rec.pop("e", None); rec.pop("g", None)    # keep re-runs idempotent
            continue

        p95_by_id[id(rec)] = hmax
        rec["e"] = int(round(hmax * 10))
        n_e += 1
        if rec["a"] >= GRID_AREA:
            grid_specs.append((rec, cx, cz, bx0, bz0, bw, bd))
        else:
            rec.pop("g", None)

    # grids, with a size guard: raise the min step until the JSON fits
    step_min = GRID_STEP_MIN
    while True:
        n_g = 0
        for rec, cx, cz, bx0, bz0, bw, bd in grid_specs:
            g, gmax = build_grid(dem, cx, cz, bx0, bz0, bw, bd, step_min)
            rec["g"] = g
            rec["e"] = max(rec["e"], int(round(gmax * 10)))  # H must cover the terrain
            n_g += 1
        data["elev"] = CREDIT
        out = json.dumps(data, separators=(",", ":"))
        if len(out) <= MAX_JSON_MB * 1e6 or step_min > 200:
            break
        step_min *= 1.3
        print(f"json {len(out)/1e6:.2f} MB > {MAX_JSON_MB} MB — raising grid step to {step_min:.0f} m", flush=True)

    with open(args.map, "w") as f:
        f.write(out)

    # ---- report + sanity ----
    print(f"\nislands: {len(islands)}  measured e: {n_e}  grids: {n_g}  "
          f"grid step_min: {step_min:.0f} m  json: {len(out)/1e6:.2f} MB")
    small = [r["e"] / 10 for r in islands if r["a"] < 50_000 and "e" in r]
    med_small = float(np.median(small)) if small else float("nan")
    print(f"small skerries (<50k m2) measured: {len(small)}  median height: {med_small:.1f} m")

    print("\nbefore/after (old terrarium/EU-DEM e vs new NLS 10 m; new shows p95 and stored e):")
    print(f"  {'island':<10} {'old e':>7} {'new p95':>8} {'new e':>7}")
    for n in table_names:
        r = biggest.get(n)
        if r is None:
            print(f"  {n:<10} MISSING"); continue
        o = f"{old_e[n]/10:.1f}" if old_e.get(n) else "-"
        p = f"{p95_by_id[id(r)]:.1f}" if id(r) in p95_by_id else "-"
        w = f"{r['e']/10:.1f}" if "e" in r else "-"
        print(f"  {n:<10} {o:>7} {p:>8} {w:>7}")

    # the height bands describe the island as a whole; an island agrees with
    # its band if EITHER the p95 summary OR the stored peak (e, raised to the
    # grid max so the runtime terrain fits under it) lands inside — both are
    # printed, nothing is hidden
    def band(name, lo, hi):
        r = biggest.get(name)
        if r is None or "e" not in r:
            return False, f"{name}: no measurement (want {lo}-{hi} m)"
        p95 = p95_by_id.get(id(r), r["e"] / 10)
        e = r["e"] / 10
        ok = (lo <= p95 <= hi) or (lo <= e <= hi)
        return ok, f"{name}: p95 {p95:.1f} m / e {e:.1f} m (want {lo}-{hi} m)"

    checks = []
    def chk(cond, msg):
        checks.append(cond)
        print(f"  {'OK ' if cond else 'FAIL'} {msg}")

    print("\nsanity:")
    chk(*band("Jurmo", 0, 16))
    chk(*band("Utö", 15, 25))
    chk(*band("Nötö", 20, 30))
    chk(*band("Berghamn", 20, 32))
    chk(n_e > 6000, f"measured: {n_e} of {len(islands)} (want >6000)")
    chk(2 <= med_small <= 12, f"small-skerry median: {med_small:.1f} m (want 2-12)")
    if not all(checks):
        print("\nSANITY FAILED — json written, but investigate before trusting it")
        sys.exit(1)
    print("\nall sanity checks passed")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Bake REAL elevations from the NLS Finland open 10 m DEM onto the map.

Source: National Land Survey of Finland (Maanmittauslaitos) open elevation
model 10 m ("korkeusmalli 10 m"), CC BY 4.0, mirrored openly (no auth) at
Paituli/Funet:
  https://www.nic.funet.fi/index/geodata/mml/dem10m/
The mirror ships EPSG:3067 (ETRS-TM35FIN) Float32 GeoTIFF map sheets
(24 x 12 km, 10 m/px) plus a dem10m_direct.vrt master index that gives each
sheet's exact placement — we use the VRT to pick only sheets intersecting
record bounding boxes (+100 m).

v2 (expanded world): reads a RAW map (no elevation; e.g. the bake_map.py
output) via --src and writes the shipping map via --out. Every non-elevation
field is preserved verbatim (e/g are spliced in; p/k/a/n/q are not touched).
Two record classes:

  ISLANDS (k != 'mainland') — unchanged semantics from the first NLS bake:
    e : real height, decimetres (95th percentile of interior DEM samples on
        a PIP-filtered lattice; islands <= 80 m across use the tallest
        nearest-pixel value instead, because bilinear smears 1-2 px rocks
        into the sea; raised to the grid max where a grid exists)
    g : height grid for islands >= 25,000 m^2 — {x0,z0,dx,dz,nx,nz,v:[dm..]}
        in LOCAL island coords (vertex-mean centroid, same arithmetic as
        archipelago.js), step >= 25 m (auto-raised if the JSON exceeds the
        size cap), <= 900 nodes.

  MAINLAND tiles (k == 'mainland', carry q cut-edge masks) — grid REQUIRED
    wherever the Finnish DEM has coverage, on a GLOBALLY ALIGNED 260 m
    lattice: node world positions are exact multiples of 260 in the game
    frame, so adjacent tiles sample identical world points and their seams
    match exactly (node values come from one shared cache, so they are
    bitwise identical across tiles). x0/z0 are stored in local tile coords
    with 2 decimals. Nodes over sea (NoData or <= 0) store 0. e = grid max.
    <= 1,100 nodes per tile (an 8 km tile at 260 m is <= 33 x 33 = 1,089).

  ESTONIA: the expanded box clips the Estonian coast (Purekkari tiles,
    Prangli/Aksi/Naissaar...). The Finnish NLS DEM has no sheets there —
    those records are detected up front (bbox intersects zero VRT sources),
    get no e/g, and are excluded from the Finnish coverage gate. The runtime
    falls back to its low-coast profile for them. No foreign DEM is fetched.

Network discipline: curl -sS -f -m 120 --retry 2 per sheet, a cheap probe
before any batch download, progress prints. A VRT-listed sheet that cannot
be fetched is FATAL (we never fake heights) unless --allow-missing-sheets.
With a warm cache the tool performs zero network I/O and the output is
byte-identical across runs (deterministic; gate 6).

Sanity gates (each prints a table; any failure exits nonzero):
  1. old-benchmark continuity vs --old-map (Jurmo/Utö/Aspö/Nötö/Berghamn,
     located in the new map through --remap old->new indices). Hard: the
     OLD rings re-measured through this pipeline must reproduce the old
     stored e within +-0.5 m, and p95 old-ring vs new-ring within +-0.5 m.
     The literal stored-e figure is also printed; where it drifts beyond
     +-0.5 m purely because the upstream OSM rings changed (bbox-anchored
     grid lattices are phase-sensitive), that is a loud WARN, not a
     failure — matching it would mean writing stale values over honestly
     measured ones. --strict-bench makes it fail instead.
  2. new-area spot heights (Kemiönsaari, Emäsalo, Isosaari, Russarö, Örö)
  3. >= 95 % of Finnish ISLAND land area carries e (Estonia excluded)
  4. mainland: >= 180/221 tiles gridded; seam continuity <= 0.15 m on
     >= 30 random shared-border points away from the coast
  5. output <= --max-mb, parses, record order identical to --src

Typical invocation (paths from the expanded-world bake session):
  python3 tools/bake_elevation_nls.py \
    --src  <scratch>/map_expanded_raw.json \
    --out  public/archipelago_map.json \
    --cache <scratch>/nlsdem \
    --old-map <scratch>/old_map_snapshot.json \
    --remap <scratch>/cover_remap.json
"""
import argparse, json, math, os, re, subprocess, sys, time

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
CLIP_MAX = 80.0                     # m — island cap; nothing insular here is higher
MIN_REAL = 0.3                      # m — 10 m DEM resolves small skerries
P95_MAX_SAMPLES = 400_000           # cap the interior lattice for very large islands

ML_STEP = 260.0                     # m — mainland lattice, globally aligned
ML_MAX_NODES = 1100
ML_CLIP = 200.0                     # m — coastal-strip hills stay well below this

CREDIT = ("per-island and mainland heights (dm) from NLS Finland open DEM 10 m "
          "(Maanmittauslaitos, CC BY 4.0) via Paituli/Funet; "
          "records without 'e' are procedural")

BENCH_NAMES = ("Jurmo", "Utö", "Aspö", "Nötö", "Berghamn")

# new-area spot checks: name, disambiguation lat/lon, band (m), note
SPOTS = [
    ("Kimitoön", 60.16, 22.72, 30.0, 999.0, "Kemiönsaari"),
    ("Emäsalo",  60.32, 25.62, 15.0, 50.0,  "Porvoo"),
    ("Isosaari", 60.104, 25.054, 5.0, 30.0, "Helsinki"),
    ("Russarö",  59.767, 22.943, 5.0, 25.0, "Hanko"),
    ("Örö",      59.810, 22.330, 5.0, 25.0, ""),
]


def world_to_lonlat(x, z):
    return LON0 + x / M_LON, LAT0 - z / M_LAT


def lonlat_to_world(lon, lat):
    return (lon - LON0) * M_LON, -(lat - LAT0) * M_LAT


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


def fetch(url, dest, timeout=120):
    """Disciplined downloader: curl -m 120 --retry 2, atomic rename."""
    part = dest + ".part"
    r = subprocess.run(["curl", "-sS", "-f", "-m", str(timeout), "--retry", "2",
                        "-o", part, url], capture_output=True, text=True)
    if r.returncode == 0 and os.path.getsize(part) > 0:
        os.replace(part, dest)
        return True
    if os.path.exists(part):
        os.remove(part)
    print(f"  fetch FAILED {os.path.basename(dest)}: {r.stderr.strip()[:200]}", flush=True)
    return False


def probe(url):
    """Cheap reachability check before a batch (HEAD, 30 s)."""
    r = subprocess.run(["curl", "-sS", "-f", "-I", "-m", "30", url],
                       capture_output=True, text=True)
    return r.returncode == 0


class Dem:
    """Mosaic of NLS 10 m sheets, indexed by each GeoTIFF's own tiepoint."""

    def __init__(self, cache):
        self.cache = os.path.join(cache, "tif")
        os.makedirs(self.cache, exist_ok=True)
        self.paths = {}     # (kx, ky) sheet-lattice cell -> tif path
        self.arrays = {}    # (kx, ky) -> float32 array (nodata already zeroed)
        self.downloaded = 0
        self.downloaded_bytes = 0

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

    def ensure_sheets(self, records, allow_missing=False):
        """Parse the VRT, select sheets intersecting record bboxes (+100 m),
        download any not yet cached, register everything. Returns a bool
        array: record bbox intersects >= 1 VRT source (i.e. Finnish DEM
        coverage exists at all — False means Estonia / outside Finland)."""
        vrt_path = os.path.join(self.cache, "..", VRT)
        if not os.path.exists(vrt_path):
            print("fetching VRT index...", flush=True)
            if not probe(BASE + VRT) or not fetch(BASE + VRT, vrt_path):
                sys.exit("FATAL: DEM mirror unreachable (VRT index) — stopping, not faking heights")
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
        print(f"VRT sources: {len(sources)}", flush=True)

        # padded record bboxes in EPSG:3067
        boxes = []
        for rec in records:
            pts = np.asarray(rec["p"], dtype=np.float64)
            xs = np.array([pts[:, 0].min(), pts[:, 0].max()])
            zs = np.array([pts[:, 1].min(), pts[:, 1].max()])
            XX, ZZ = np.meshgrid(xs, zs)
            lon, lat = world_to_lonlat(XX.ravel(), ZZ.ravel())
            E, N = tm35fin(lon, lat)
            boxes.append((E.min() - 100, N.min() - 100, E.max() + 100, N.max() + 100))
        boxes = np.asarray(boxes)

        need = []
        covered = np.zeros(len(records), dtype=bool)
        for fn, emin, nmin, emax, nmax in sources:
            hit = ((boxes[:, 0] < emax) & (boxes[:, 2] > emin) &
                   (boxes[:, 1] < nmax) & (boxes[:, 3] > nmin))
            if hit.any():
                need.append(fn)
                covered |= hit
        missing = [fn for fn in need
                   if not os.path.exists(os.path.join(self.cache, os.path.basename(fn)))
                   or os.path.getsize(os.path.join(self.cache, os.path.basename(fn))) == 0]
        print(f"sheets needed: {len(need)}  cached: {len(need) - len(missing)}  to download: {len(missing)}",
              flush=True)

        if missing:                          # probe before batch — never hang on a dead mirror
            if not probe(BASE + missing[0]):
                sys.exit("FATAL: DEM mirror unreachable — stopping, not faking heights")
            t0 = time.time()
            failed = []
            for k, fn in enumerate(missing):
                dest = os.path.join(self.cache, os.path.basename(fn))
                if not fetch(BASE + fn, dest):
                    failed.append(fn)
                    continue
                self.downloaded += 1
                self.downloaded_bytes += os.path.getsize(dest)
                if (k + 1) % 10 == 0 or k + 1 == len(missing):
                    print(f"  {k + 1}/{len(missing)} sheets "
                          f"({self.downloaded_bytes / 1e6:.0f} MB, {time.time() - t0:.0f}s)", flush=True)
            if failed and not allow_missing:
                print(f"FATAL: {len(failed)} VRT-listed sheets could not be fetched: {failed[:8]}")
                sys.exit("their areas would read as sea — refusing to fake heights "
                         "(re-run to resume from cache, or pass --allow-missing-sheets)")
        for fn in need:
            dest = os.path.join(self.cache, os.path.basename(fn))
            if os.path.exists(dest) and os.path.getsize(dest) > 0:
                self.register(dest)
        print(f"sheets registered: {len(self.paths)} (downloaded now: {self.downloaded})", flush=True)
        return covered

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


class Lattice:
    """Shared cache of mainland lattice nodes, keyed by WORLD lattice index.

    Every tile reads its node values from here, so two tiles sharing a border
    store bitwise-identical dm ints for the shared world points — the seam
    continuity guarantee does not rest on float luck."""

    def __init__(self, dem):
        self.dem = dem
        self.cache = {}                     # (i, j) -> dm int

    def block(self, i0, i1, j0, j1):
        missing = [(i, j) for j in range(j0, j1 + 1) for i in range(i0, i1 + 1)
                   if (i, j) not in self.cache]
        if missing:
            xs = np.array([i * ML_STEP for i, _ in missing])
            zs = np.array([j * ML_STEP for _, j in missing])
            h = np.clip(self.dem.sample_world(xs, zs), 0.0, ML_CLIP)
            for (ij, v) in zip(missing, h):
                self.cache[ij] = int(round(v * 10))
        return [self.cache[(i, j)] for j in range(j0, j1 + 1) for i in range(i0, i1 + 1)]


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


def island_height(dem, rec):
    """Measured island height (m, before the grid-max raise) + local frame.

    One shared code path for the bake loop AND the benchmark-reproduction
    gate, so 'the gate runs the same pipeline' is true by construction.
    Returns (hmax, cx, cz, bx0, bz0, bw, bd); hmax < MIN_REAL means the DEM
    could not tell the island from sea (stays procedural)."""
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
        # interior sample lattice (local coords), PIP-filtered; capped at
        # P95_MAX_SAMPLES so the expanded world's very large islands
        # (Kimitoön is 548 km^2) stay tractable — the cap never triggers
        # at old-map island sizes, so benchmark continuity is unaffected
        step = float(np.clip(min(bw, bd) / 8.0, 8.0, 20.0))
        while (bw / step) * (bd / step) > P95_MAX_SAMPLES:
            step *= 1.5
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
    return hmax, cx, cz, bx0, bz0, bw, bd


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


def build_mainland_grid(lattice, cx, cz, bx0, bz0, bx1, bz1):
    """260 m grid on the global game-frame lattice, covering the tile bbox."""
    i0 = math.floor((cx + bx0) / ML_STEP)
    i1 = math.ceil((cx + bx1) / ML_STEP)
    j0 = math.floor((cz + bz0) / ML_STEP)
    j1 = math.ceil((cz + bz1) / ML_STEP)
    nx, nz = i1 - i0 + 1, j1 - j0 + 1
    v = lattice.block(i0, i1, j0, j1)
    g = {
        # local coords; 2 decimals keep the world lattice aligned to < 5 mm
        "x0": round(i0 * ML_STEP - cx, 2), "z0": round(j0 * ML_STEP - cz, 2),
        "dx": 260, "dz": 260,
        "nx": nx, "nz": nz,
        "v": v,
    }
    return g, max(v) / 10.0, nx * nz


def grid_bilinear(g, lx, lz):
    """Python twin of archipelago.js gridH (clamped bilinear, dm -> m)."""
    fx = (lx - g["x0"]) / g["dx"]
    fz = (lz - g["z0"]) / g["dz"]
    ix = min(max(int(math.floor(fx)), 0), g["nx"] - 2)
    iz = min(max(int(math.floor(fz)), 0), g["nz"] - 2)
    tx = min(max(fx - ix, 0.0), 1.0)
    tz = min(max(fz - iz, 0.0), 1.0)
    v = g["v"]; i00 = iz * g["nx"] + ix
    return ((v[i00] * (1 - tx) + v[i00 + 1] * tx) * (1 - tz)
            + (v[i00 + g["nx"]] * (1 - tx) + v[i00 + g["nx"] + 1] * tx) * tz) * 0.1


def centroid(rec):
    p = np.asarray(rec["p"], dtype=np.float64)
    return float(p[:, 0].mean()), float(p[:, 1].mean())


def locate_benchmarks(map_islands):
    """Old benchmark rule: biggest record per name; Berghamn = nearest to Nötö
    (several islands carry that name; the reference one is ~11 km away)."""
    biggest = {}
    for i, rec in enumerate(map_islands):
        n = rec.get("n")
        if n in BENCH_NAMES and (n not in biggest or rec["a"] > map_islands[biggest[n]]["a"]):
            biggest[n] = i
    if "Nötö" in biggest:
        ncx, ncz = centroid(map_islands[biggest["Nötö"]])
        cands = [i for i, r in enumerate(map_islands) if r.get("n") == "Berghamn"]
        if cands:
            biggest["Berghamn"] = min(
                cands, key=lambda i: (centroid(map_islands[i])[0] - ncx) ** 2
                                     + (centroid(map_islands[i])[1] - ncz) ** 2)
    return biggest


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", required=True, help="input map JSON (raw bake_map output)")
    ap.add_argument("--out", required=True, help="output shipping map JSON")
    ap.add_argument("--cache", required=True, help="raster cache dir (keep OUTSIDE the repo)")
    ap.add_argument("--old-map", help="previous shipping map (benchmark continuity gate)")
    ap.add_argument("--remap", help="old->new island index map (locates old benchmarks in --src)")
    ap.add_argument("--max-mb", type=float, default=11.0, help="hard output size cap (MB, 1e6 bytes)")
    ap.add_argument("--allow-missing-sheets", action="store_true",
                    help="continue if a VRT-listed sheet cannot be fetched (their areas read as sea)")
    ap.add_argument("--strict-bench", action="store_true",
                    help="fail (not just warn) when stored benchmark e drifts >0.5 m due to "
                         "upstream ring changes, even though the pipeline reproduces old rings exactly")
    args = ap.parse_args()

    t_start = time.time()
    data = json.load(open(args.src))
    records = data["islands"]
    for rec in records:                      # idempotency: start from a clean slate
        rec.pop("e", None); rec.pop("g", None)
    islands = [r for r in records if r.get("k") != "mainland"]
    mainland = [r for r in records if r.get("k") == "mainland"]
    print(f"records: {len(records)} ({len(islands)} islands + {len(mainland)} mainland tiles)", flush=True)

    # ---- phase 1: sheets --------------------------------------------------
    print(f"\n[phase 1] DEM sheets ({time.time() - t_start:.0f}s)", flush=True)
    dem = Dem(args.cache)
    covered = dem.ensure_sheets(records, allow_missing=args.allow_missing_sheets)
    est_island = sum(1 for r, c in zip(records, covered) if not c and r.get("k") != "mainland")
    est_main = sum(1 for r, c in zip(records, covered) if not c and r.get("k") == "mainland")
    print(f"records with NO Finnish DEM coverage (Estonia/out-of-VRT): "
          f"{est_island} islands + {est_main} mainland tiles", flush=True)
    cov_by_id = {id(r): bool(c) for r, c in zip(records, covered)}

    # ---- phase 2: island heights ------------------------------------------
    print(f"\n[phase 2] island heights ({time.time() - t_start:.0f}s)", flush=True)
    t0 = time.time()
    n_e = 0
    p95_by_id = {}                                    # id(rec) -> p95 before grid-max raise
    grid_specs = []                                   # (rec, cx, cz, bx0, bz0, bw, bd)
    for i, rec in enumerate(islands):
        if i and i % 2000 == 0:
            print(f"  ...{i}/{len(islands)} islands ({time.time() - t0:.0f}s)", flush=True)
        if not cov_by_id[id(rec)]:
            continue                                  # Estonian: stays procedural
        hmax, cx, cz, bx0, bz0, bw, bd = island_height(dem, rec)
        if hmax < MIN_REAL:
            continue

        p95_by_id[id(rec)] = hmax
        rec["e"] = int(round(hmax * 10))
        n_e += 1
        if rec["a"] >= GRID_AREA:
            grid_specs.append((rec, cx, cz, bx0, bz0, bw, bd))
    print(f"  islands measured: {n_e}/{len(islands)}  grid candidates: {len(grid_specs)}", flush=True)

    # ---- phase 3: mainland lattice grids ----------------------------------
    print(f"\n[phase 3] mainland 260 m lattice ({time.time() - t_start:.0f}s)", flush=True)
    lattice = Lattice(dem)
    n_mg = 0
    ml_zero = 0
    ml_worst_nodes = 0
    for rec in mainland:
        if not cov_by_id[id(rec)]:
            continue                                  # Estonian tiles: low-coast fallback
        pts = np.asarray(rec["p"], dtype=np.float64)
        cx, cz = pts[:, 0].mean(), pts[:, 1].mean()
        ring = pts - [cx, cz]
        g, gmax, nodes = build_mainland_grid(
            lattice, cx, cz, ring[:, 0].min(), ring[:, 1].min(),
            ring[:, 0].max(), ring[:, 1].max())
        ml_worst_nodes = max(ml_worst_nodes, nodes)
        if nodes > ML_MAX_NODES:
            sys.exit(f"FATAL: mainland tile needs {nodes} nodes > {ML_MAX_NODES} cap "
                     "(tile larger than the 260 m lattice budget — split it upstream)")
        rec["g"] = g
        n_mg += 1
        if gmax > 0:
            rec["e"] = int(round(gmax * 10))
        else:
            ml_zero += 1                              # all-sea lattice: keep grid, no e
    print(f"  mainland grids: {n_mg}/{len(mainland)}  (all-zero: {ml_zero}, "
          f"largest grid: {ml_worst_nodes} nodes, lattice cache: {len(lattice.cache)} nodes)", flush=True)

    # ---- phase 4: island grids + size guard -------------------------------
    print(f"\n[phase 4] island grids + size cap ({time.time() - t_start:.0f}s)", flush=True)
    step_min = GRID_STEP_MIN
    built = {}                                        # id(rec) -> (dx, dz) of built grid
    while True:
        n_g = 0
        for rec, cx, cz, bx0, bz0, bw, bd in grid_specs:
            dx = max(step_min, bw / GRID_DIV)
            dz = max(step_min, bd / GRID_DIV)
            if built.get(id(rec)) != (dx, dz):        # only rebuild what the step change touches
                g, gmax = build_grid(dem, cx, cz, bx0, bz0, bw, bd, step_min)
                rec["g"] = g
                rec["e"] = max(int(round(p95_by_id[id(rec)] * 10)), int(round(gmax * 10)))
                built[id(rec)] = (dx, dz)
            n_g += 1
        data["elev"] = CREDIT
        out = json.dumps(data, separators=(",", ":"))
        if len(out) <= args.max_mb * 1e6 or step_min > 200:
            break
        step_min *= 1.3
        print(f"  json {len(out)/1e6:.2f} MB > {args.max_mb} MB — raising island grid step "
              f"to {step_min:.0f} m (mainland lattice stays 260 m)", flush=True)

    with open(args.out, "w") as f:
        f.write(out)
    print(f"  wrote {args.out}: {len(out)/1e6:.2f} MB  "
          f"(islands with e: {n_e}, island grids: {n_g}, mainland grids: {n_mg}, "
          f"island grid step_min: {step_min:.0f} m)", flush=True)

    # ---- gates -------------------------------------------------------------
    print(f"\n[gates] ({time.time() - t_start:.0f}s)", flush=True)
    fails = []

    def chk(gate, cond, msg):
        print(f"  {'OK  ' if cond else 'FAIL'} [{gate}] {msg}", flush=True)
        if not cond:
            fails.append(gate)

    # gate 1: old-benchmark continuity through the remap.
    # Two tiers, because the upstream map refresh changes the RINGS (denser
    # OSM coastline, moved centroids), and the stored e is raised to the max
    # of a bbox-anchored grid lattice — a value that is honest but PHASE-
    # SENSITIVE: re-anchoring the lattice on a slightly different bbox moves
    # the sampled peak by a metre or two even on identical DEM data.
    #   tier A (HARD): re-measure the OLD rings through this very pipeline —
    #     must reproduce the old file's stored e within ±0.5 m (pipeline
    #     regression check; identical rings must give identical heights).
    #   tier B (HARD): p95 measurement continuity old-ring vs new-ring
    #     within ±0.5 m (the measurement itself must be stable).
    #   tier C: stored e new vs old within ±0.5 m — the literal continuity
    #     figure; where it drifts while A+B hold, the cause is the ring
    #     refresh, reported loudly as RING-DRIFT (hard only with
    #     --strict-bench, since matching it would mean writing stale values
    #     over the honestly measured ones).
    print("gate 1 — benchmark continuity (stored e, m; repro = old ring through this pipeline):")
    if args.old_map and args.remap:
        old = json.load(open(args.old_map))["islands"]
        remap = json.load(open(args.remap))
        old_idx = locate_benchmarks(old)
        print(f"  {'island':<10} {'old idx':>7} {'old e':>6} {'repro e':>8} {'old p95':>8} "
              f"{'new idx':>8} {'new p95':>8} {'new e':>6} {'delta':>6}")
        for n in BENCH_NAMES:
            oi = old_idx.get(n)
            if oi is None:
                chk("bench", False, f"{n}: not found in old map"); continue
            ni = remap.get(str(oi))
            if ni is None:
                chk("bench", False, f"{n}: old index {oi} missing from remap"); continue
            r = records[ni]
            oe = old[oi].get("e")
            ne = r.get("e")
            p95_n = p95_by_id.get(id(r))
            # tier A/B: reproduce the old record with the live pipeline
            h_o, ocx, ocz, obx0, obz0, obw, obd = island_height(dem, old[oi])
            e_repro = int(round(h_o * 10))
            if old[oi].get("g"):
                _, gmax_o = build_grid(dem, ocx, ocz, obx0, obz0, obw, obd, GRID_STEP_MIN)
                e_repro = max(e_repro, int(round(gmax_o * 10)))
            if oe is None or ne is None or p95_n is None or r.get("n") != n:
                chk("bench", False, f"{n}: missing e/p95 or name mismatch (old e {oe}, new e {ne})")
                continue
            print(f"  {n:<10} {oi:>7} {oe/10:>6.1f} {e_repro/10:>8.1f} {h_o:>8.1f} "
                  f"{ni:>8} {p95_n:>8.1f} {ne/10:>6.1f} {(ne-oe)/10:>+6.1f}")
            chk("bench", abs(e_repro - oe) <= 5,
                f"{n}: pipeline repro of OLD ring {e_repro/10:.1f} m vs shipped {oe/10:.1f} m (±0.5)")
            chk("bench", abs(p95_n - h_o) <= 0.5,
                f"{n}: p95 continuity old-ring {h_o:.1f} m vs new-ring {p95_n:.1f} m (±0.5)")
            stored_ok = abs(ne - oe) <= 5
            if stored_ok:
                chk("bench", True, f"{n}: stored e {oe/10:.1f} -> {ne/10:.1f} m (±0.5)")
            else:
                msg = (f"{n}: stored e {oe/10:.1f} -> {ne/10:.1f} m exceeds ±0.5 — RING-DRIFT "
                       "(upstream ring/bbox changed; grid-lattice phase moved the stored peak)")
                if args.strict_bench:
                    chk("bench", False, msg)
                else:
                    print(f"  WARN [bench] {msg}", flush=True)
    else:
        print("  (skipped: pass --old-map and --remap to enable)")

    # gate 2: new-area spot heights
    print("gate 2 — new-area spot heights:")
    for name, lat, lon, lo, hi, note in SPOTS:
        wx, wz = lonlat_to_world(lon, lat)
        cands = [(i, r) for i, r in enumerate(records) if r.get("n") == name]
        if not cands:
            chk("spots", False, f"{name}: no record with that name"); continue
        i, r = min(cands, key=lambda t: (centroid(t[1])[0] - wx) ** 2 + (centroid(t[1])[1] - wz) ** 2)
        e = r.get("e")
        p95 = p95_by_id.get(id(r))
        band = f"{lo:g}-{hi:g}" if hi < 999 else f">={lo:g}"
        ok = e is not None and (lo <= e / 10 <= hi or (p95 is not None and lo <= p95 <= hi))
        chk("spots", ok, f"{name}{' (' + note + ')' if note else ''}: idx {i}, "
            f"p95 {p95 if p95 is not None else float('nan'):.1f} m, "
            f"e {e/10 if e else float('nan'):.1f} m (want {band} m)")

    # gate 3: measured island coverage by land area (Finland only)
    fin_area = sum(r["a"] for r in islands if cov_by_id[id(r)])
    fin_e_area = sum(r["a"] for r in islands if cov_by_id[id(r)] and "e" in r)
    frac = fin_e_area / fin_area if fin_area else 0.0
    chk("coverage", frac >= 0.95,
        f"Finnish island land area with e: {frac*100:.2f}% "
        f"({fin_e_area/1e6:.0f}/{fin_area/1e6:.0f} km², Estonian records excluded) — want >=95%")

    # gate 4a: mainland grid count
    chk("mainland", n_mg >= 180, f"mainland tiles with grids: {n_mg}/{len(mainland)} (want >=180)")

    # gate 4b: seam continuity across shared tile borders
    import random
    rng = random.Random(20260707)
    grids = []
    for rec in mainland:
        if "g" not in rec:
            continue
        cx, cz = centroid(rec)
        pts = np.asarray(rec["p"], float)
        grids.append({
            "g": rec["g"], "cx": cx, "cz": cz,
            "x0": pts[:, 0].min(), "x1": pts[:, 0].max(),
            "z0": pts[:, 1].min(), "z1": pts[:, 1].max(),
        })
    samples = []                                       # (delta, wx, wz)
    for a in range(len(grids)):
        for b in range(a + 1, len(grids)):
            A, B = grids[a], grids[b]
            # vertical shared border (A right edge == B left edge) and mirrored
            for P, Q in ((A, B), (B, A)):
                if abs(P["x1"] - Q["x0"]) < 2.0:
                    zlo, zhi = max(P["z0"], Q["z0"]) + 260, min(P["z1"], Q["z1"]) - 260
                    if zhi > zlo:
                        bx = (P["x1"] + Q["x0"]) / 2
                        for _ in range(4):
                            wz = rng.uniform(zlo, zhi)
                            samples.append((P, Q, bx, wz))
                if abs(P["z1"] - Q["z0"]) < 2.0:
                    xlo, xhi = max(P["x0"], Q["x0"]) + 260, min(P["x1"], Q["x1"]) - 260
                    if xhi > xlo:
                        bz = (P["z1"] + Q["z0"]) / 2
                        for _ in range(4):
                            wx = rng.uniform(xlo, xhi)
                            samples.append((P, Q, wx, bz))
    def nodes_positive(T, wx, wz):
        g = T["g"]
        fx = (wx - T["cx"] - g["x0"]) / g["dx"]; fz = (wz - T["cz"] - g["z0"]) / g["dz"]
        ix = min(max(int(math.floor(fx)), 0), g["nx"] - 2)
        iz = min(max(int(math.floor(fz)), 0), g["nz"] - 2)
        v = g["v"]; i00 = iz * g["nx"] + ix
        return min(v[i00], v[i00 + 1], v[i00 + g["nx"]], v[i00 + g["nx"] + 1]) > 0
    deltas = []
    for P, Q, wx, wz in samples:
        if not (nodes_positive(P, wx, wz) and nodes_positive(Q, wx, wz)):
            continue                                   # coastal / sea-touching: skip
        hP = grid_bilinear(P["g"], wx - P["cx"], wz - P["cz"])
        hQ = grid_bilinear(Q["g"], wx - Q["cx"], wz - Q["cz"])
        deltas.append(abs(hP - hQ))
    if deltas:
        chk("seams", len(deltas) >= 30 and max(deltas) <= 0.15,
            f"seam continuity: {len(deltas)} border points (want >=30), "
            f"max delta {max(deltas)*100:.1f} cm (want <=15 cm)")
    else:
        chk("seams", False, "seam continuity: no inland shared-border points found")

    # gate 5: size, parse, record order vs --src
    chk("size", len(out) <= args.max_mb * 1e6,
        f"output {len(out)/1e6:.2f} MB (cap {args.max_mb} MB)")
    reread = json.load(open(args.out))
    raw = json.load(open(args.src))
    order_ok = len(reread["islands"]) == len(raw["islands"]) and all(
        a["p"] == b["p"] and a.get("k") == b.get("k") and a.get("a") == b.get("a")
        and a.get("n") == b.get("n") and a.get("q") == b.get("q")
        for a, b in zip(reread["islands"], raw["islands"]))
    chk("order", order_ok, "record order + non-elevation fields identical to --src")

    # context stats (printed, not gated hard)
    small = [r["e"] / 10 for r in islands if r["a"] < 50_000 and "e" in r]
    med_small = float(np.median(small)) if small else float("nan")
    print(f"\nstats: measured islands {n_e} | island grids {n_g} | mainland grids {n_mg} | "
          f"small-skerry (<50k m²) median {med_small:.1f} m | "
          f"downloads this run: {dem.downloaded} sheets / {dem.downloaded_bytes/1e6:.0f} MB | "
          f"total {time.time() - t_start:.0f}s")

    if fails:
        print(f"\nGATES FAILED: {sorted(set(fails))} — json written, but do not ship without investigating")
        sys.exit(1)
    print("\nall gates passed")


if __name__ == "__main__":
    main()

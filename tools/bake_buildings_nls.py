#!/usr/bin/env python3
"""Bake REAL building footprints from the NLS Finland Topographic Database.

Source: National Land Survey of Finland (Maanmittauslaitos) Topographic
Database ("maastotietokanta", CC BY 4.0), open per-map-sheet shapefile
distribution on the Paituli/Funet mirror (no auth, no API key):
  https://www.nic.funet.fi/index/geodata/mml/maastotietokanta/2025/shp/
Each TM35 leaf sheet (24 x 12 km, e.g. K3232) ships as two half-sheet zips
(K3232L / K3232R, 12 x 12 km each). Building footprints are the theme-"r"
polygon layer (r_<sheet>_p.shp, RYHMA 75), EPSG:3067, with the use class in
LUOKKA (verified against maastotietokanta_kohdemalli_eng.xlsx):
  42210/11/12 residential   42220/21/22 office or public
  42230/31/32 holiday       42240/41/42 industrial
  42250/51/52 religious     42270 church      42260/61/62 other building

Why NLS and not OSM: OSM building coverage in the outer archipelago is
patchy (whole inhabited island halves missing); the topographic database is
the national base map and is near-complete. NLS therefore becomes the base
layer, and an existing OSM building is kept only when no NLS building centre
lies within MERGE_R of it (those are the same building mapped twice).

Output: rewrites ONLY the "buildings" array of public/archipelago_data.json
(nature/piers/seamarks spans stay byte-identical — the array is spliced into
the raw text, not re-serialised). Record format, matching the OSM bake:
  [x, z, w, d, ang, cls]
  x/z  game-frame centre, 1 decimal   (x east, z south of LAT0/LON0)
  w/d  footprint metres, 1 decimal    (minimum-area rect via rotating
                                       calipers on the convex hull)
  ang  radians, 2 decimals            (rotateY angle for BoxGeometry(w,h,d);
                                       normalised to [-pi/2, pi/2) — note
                                       (w,d,ang) == (d,w,ang+pi/2))
  cls  0 building, 1 small outbuilding/sauna/shed, 2 church

Class mapping (documented guess where NLS has no 1:1 concept):
  42270 church                                  -> 2
  42250/51/52 religious (chapels etc., rare)    -> 2
  polygon area < 25 m^2                         -> 1
  4226x "other building" (talousrakennus: sheds, saunas, boathouses, barns)
        with polygon area < 120 m^2             -> 1
  everything else                               -> 0

Coordinates: shapefiles are EPSG:3067 (ETRS-TM35FIN). Forward transform is
ported from bake_elevation_nls.py; the inverse is vectorised Newton on that
forward (round-trip error is checked and must be < 0.5 m, measured ~2e-9 m).
Rect corners are inverse-projected and the game-frame w/d/ang derived from
the projected corners, so meridian convergence (~4.8 deg at lon 21.5) and the
equirectangular game frame are handled exactly like the OSM-native bake.

Sheet-boundary care: a building crossing a half-sheet edge appears in both
zips (clipped or duplicated). Identical rings are deduped by geometry hash;
remaining same-KOHDEOSO fragments whose bboxes touch are unioned before the
rect fit, so a straddling building yields one rectangle, not two halves.

Idempotent: deterministic derivation + canonical sort; re-running against
the already-merged file reproduces it byte-for-byte (every NLS-derived
record sits on an NLS centre so it is re-dropped from the "OSM" side, and
previously kept OSM records keep failing the 12 m test the same way).

Usage:
  python3 tools/bake_buildings_nls.py --cache /path/outside/repo
Downloads (~50 MB of zips) are cached there and never touch the repo.
"""
import argparse, io, json, math, os, struct, sys, time, urllib.request, zipfile

import numpy as np

# ---------------------------------------------------------------- constants
LAT0, LON0 = 59.805, 21.49            # game-frame origin (archipelago_map.json)
M_LAT = 111320.0
M_LON = 111320.0 * math.cos(math.radians(LAT0))

BBOX = (59.70, 60.20, 21.15, 22.35)   # lat_min, lat_max, lon_min, lon_max

BASE = "https://www.nic.funet.fi/index/geodata/mml/maastotietokanta/2025/shp/"

MIN_AREA = 6.0                        # m^2 — skip degenerate footprints
SMALL_AREA = 25.0                     # m^2 — below this: cls 1
OTHER_SMALL_AREA = 120.0              # m^2 — 4226x below this: cls 1
MERGE_R = 12.0                        # m — OSM within this of an NLS centre = same building
MAX_JSON_MB = 4.5
MAX_TOTAL = 60000
CLS_CHURCH = {42270, 42250, 42251, 42252}
CLS_OTHER = {42260, 42261, 42262}

CREDIT = ("buildings from NLS Finland Topographic Database "
          "(Maanmittauslaitos, CC BY 4.0) via Paituli/Funet, "
          "merged with OSM where NLS has no twin within 12 m")

# ------------------------------------------------- ETRS-TM35FIN (EPSG:3067)
# forward: Redfearn/Snyder series on GRS80, ported from bake_elevation_nls.py
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


def tm35fin_inv(E, N, iters=4):
    """Vectorised EPSG:3067 E,N (m) -> lon,lat (deg): Newton on the forward.

    Quadratic convergence from a ~km-accurate seed; 4 iterations land at
    ~1e-9 m (verified by the round-trip gate in main)."""
    E = np.asarray(E, dtype=np.float64)
    N = np.asarray(N, dtype=np.float64)
    lat = N / 110946.0
    lon = 27.0 + (E - _FE) / (111320.0 * np.cos(np.radians(lat)) * _K0)
    dl = 1e-6                                       # deg — numeric Jacobian step
    for _ in range(iters):
        E0, N0 = tm35fin(lon, lat)
        E1, N1 = tm35fin(lon + dl, lat)
        E2v, N2v = tm35fin(lon, lat + dl)
        a = (E1 - E0) / dl
        b = (E2v - E0) / dl
        c = (N1 - N0) / dl
        d = (N2v - N0) / dl
        det = a * d - b * c
        rE, rN = E - E0, N - N0
        lon = lon + (d * rE - b * rN) / det
        lat = lat + (-c * rE + a * rN) / det
    return lon, lat


def lonlat_to_world(lon, lat):
    return (lon - LON0) * M_LON, -(lat - LAT0) * M_LAT


# ------------------------------------------------------- TM35 sheet lattice
# leaf sheets are 24 x 12 km, named letter+4 digits (e.g. K3232); letters are
# 96 km N-S bands from K at N 6570000, the first digit is a 192 km E column
# with column 3 starting at E 116000, and each further digit picks a quadrant
# (1 SW, 2 NW, 3 SE, 4 NE — west column bottom-up, then east column).
# Verified against the dem10m VRT placements in the elevation bake.
LETTERS = "KLMNPQRSTUVWX"
ROW0_N = 6570000.0
COL3_E = 116000.0


def leaf_name(e0, n0):
    """Sheet name for the 24x12 km leaf whose SW corner is (e0, n0)."""
    row = int((n0 - ROW0_N) // 96000)
    col = 3 + int((e0 - COL3_E) // 192000)
    name = f"{LETTERS[row]}{col}"
    pe = COL3_E + (col - 3) * 192000.0
    pn = ROW0_N + row * 96000.0
    w, h = 192000.0, 96000.0
    for _ in range(3):
        w /= 2
        h /= 2
        qc = int((e0 - pe) // w)
        qr = int((n0 - pn) // h)
        name += str(1 + qc * 2 + qr)
        pe += qc * w
        pn += qr * h
    return name


def sheets_for_bbox():
    """(name, half, url_path) for every 12x12 km half-sheet touching BBOX."""
    lat_min, lat_max, lon_min, lon_max = BBOX
    t = np.linspace(0.0, 1.0, 60)
    lons = np.concatenate([lon_min + (lon_max - lon_min) * t,
                           np.full_like(t, lon_min), np.full_like(t, lon_max),
                           lon_min + (lon_max - lon_min) * t])
    lats = np.concatenate([np.full_like(t, lat_min),
                           lat_min + (lat_max - lat_min) * t,
                           lat_min + (lat_max - lat_min) * t,
                           np.full_like(t, lat_max)])
    E, N = tm35fin(lons, lats)
    e_lo, e_hi = E.min() - 200, E.max() + 200
    n_lo, n_hi = N.min() - 200, N.max() + 200
    out = []
    n0 = ROW0_N + math.floor((n_lo - ROW0_N) / 12000) * 12000
    while n0 < n_hi:
        e0 = COL3_E + math.floor((e_lo - COL3_E) / 24000) * 24000
        while e0 < e_hi:
            name = leaf_name(e0, n0)
            parent = name[:2] + "/" + name[:3]
            for half, he0 in (("L", e0), ("R", e0 + 12000)):
                if he0 < e_hi and he0 + 12000 > e_lo:
                    out.append((name, half, f"{parent}/{name}{half}.shp.zip"))
            e0 += 24000
        n0 += 12000
    return out


# ------------------------------------------------------------------ fetcher
def fetch(url, dest, tries=3, timeout=60):
    """Disciplined downloader: hard timeout, bounded retries, no hangs.

    Returns 'ok', 'missing' (HTTP 404 — open-sea half-sheets), or 'fail'."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                data = r.read()
            with open(dest, "wb") as f:
                f.write(data)
            time.sleep(0.15)
            return "ok"
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return "missing"
            print(f"  fetch {os.path.basename(dest)} attempt {attempt + 1}: HTTP {e.code}", flush=True)
        except Exception as e:
            print(f"  fetch {os.path.basename(dest)} attempt {attempt + 1}: {e}", flush=True)
        time.sleep(1.5 * (attempt + 1))
    return "fail"


# ------------------------------------------------- shapefile / dbf reading
def shp_polygon_rings(buf):
    """Ring lists per record from a type-5 (Polygon) .shp buffer.

    Returns [[ring, ...], ...] — one entry per record (empty for null
    shapes); ring = [(E, N), ...]. Holes are kept: they never touch the
    convex hull and ring-signed areas cancel in the net-area sum."""
    if len(buf) <= 100:
        return []
    ftype = struct.unpack("<i", buf[32:36])[0]
    if ftype != 5:
        raise ValueError(f"unexpected shapefile geometry type {ftype} (want 5=Polygon)")
    out = []
    off = 100
    while off + 8 <= len(buf):
        _, clen = struct.unpack(">ii", buf[off:off + 8])
        off += 8
        content = buf[off:off + clen * 2]
        off += clen * 2
        if struct.unpack("<i", content[:4])[0] != 5:
            out.append([])
            continue
        nparts, npts = struct.unpack("<ii", content[36:44])
        parts = struct.unpack(f"<{nparts}i", content[44:44 + 4 * nparts])
        po = 44 + 4 * nparts
        pts = struct.unpack(f"<{2 * npts}d", content[po:po + 16 * npts])
        rings = []
        for pi in range(nparts):
            a = parts[pi]
            b = parts[pi + 1] if pi + 1 < nparts else npts
            rings.append([(pts[2 * i], pts[2 * i + 1]) for i in range(a, b)])
        out.append(rings)
    return out


def dbf_columns(buf, wanted):
    """Per-record dict of the wanted column values from a .dbf buffer."""
    nrec, hsize, rsize = struct.unpack("<IHH", buf[4:12])
    fields = []
    p = 32
    while buf[p:p + 1] != b"\r":
        fields.append((buf[p:p + 11].split(b"\0")[0].decode("latin1"), buf[p + 16]))
        p += 32
    rows = []
    for i in range(nrec):
        raw = buf[hsize + i * rsize: hsize + (i + 1) * rsize]
        off = 1
        rec = {}
        for name, flen in fields:
            if name in wanted:
                rec[name] = raw[off:off + flen].decode("latin1", "replace").strip()
            off += flen
        rows.append(rec)
    return rows


def read_building_polygons(zip_path):
    """(gid, luokka, rings) for each building-area record in a half-sheet zip."""
    out = []
    with zipfile.ZipFile(zip_path) as z:
        shp_names = [n for n in z.namelist() if n.startswith("r_") and n.endswith("_p.shp")]
        if not shp_names:
            return out                                   # no buildings on this half-sheet
        base = shp_names[0][:-4]
        recs = shp_polygon_rings(z.read(base + ".shp"))
        rows = dbf_columns(z.read(base + ".dbf"), {"LUOKKA", "KOHDEOSO", "RYHMA"})
    for rings, row in zip(recs, rows):
        if not rings:
            continue
        try:
            luokka = int(row.get("LUOKKA") or 0)
            gid = int(row.get("KOHDEOSO") or 0)
        except ValueError:
            luokka, gid = 0, 0
        if not (42200 <= luokka <= 42299):               # buildings only (RYHMA 75 areas)
            continue
        out.append((gid, luokka, rings))
    return out


# --------------------------------------------------------- rectangle fitting
def ring_signed_area(ring):
    s = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def convex_hull(pts):
    """Andrew monotone chain; pts = [(x, y), ...] -> CCW hull."""
    pts = sorted(set(pts))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    up = []
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def min_area_rect(pts):
    """Minimum-area oriented bounding rect via rotating calipers.

    Returns (cx, cy, w, d, theta): centre, side extents, and the angle of the
    w axis (radians, CCW from +x). The optimal rect shares an edge direction
    with the hull, so scanning hull edges is exact."""
    hull = convex_hull(pts)
    if len(hull) < 3:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        if len(hull) == 2:
            (x1, y1), (x2, y2) = hull
            th = math.atan2(y2 - y1, x2 - x1)
            return ((x1 + x2) / 2, (y1 + y2) / 2, math.hypot(x2 - x1, y2 - y1), 0.0, th)
        return ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2,
                max(xs) - min(xs), max(ys) - min(ys), 0.0)
    best = None
    n = len(hull)
    for i in range(n):
        x1, y1 = hull[i]
        x2, y2 = hull[(i + 1) % n]
        ex, ey = x2 - x1, y2 - y1
        L = math.hypot(ex, ey)
        if L < 1e-9:
            continue
        ux, uy = ex / L, ey / L
        us = [p[0] * ux + p[1] * uy for p in hull]
        vs = [-p[0] * uy + p[1] * ux for p in hull]
        w = max(us) - min(us)
        d = max(vs) - min(vs)
        if best is None or w * d < best[0]:
            cu = (max(us) + min(us)) / 2
            cv = (max(vs) + min(vs)) / 2
            best = (w * d, cu * ux - cv * uy, cu * uy + cv * ux, w, d, math.atan2(uy, ux))
    _, cx, cy, w, d, th = best
    return cx, cy, w, d, th


# -------------------------------------------------------------- aggregation
def collect_buildings(cache_zip, sheet_list):
    """Read every half-sheet, dedupe boundary copies, union split fragments.

    Returns [(luokka, [pts]), ...] one entry per physical building."""
    seen_ring = set()
    by_gid = {}                                          # gid -> [record, ...]
    solo = []                                            # gid == 0
    n_raw = n_dup = 0
    for name, half, _ in sheet_list:
        path = os.path.join(cache_zip, f"{name}{half}.shp.zip")
        if not os.path.exists(path):
            continue
        for gid, luokka, rings in read_building_polygons(path):
            n_raw += 1
            kept = []
            for ring in rings:
                key = (gid, hash(tuple((round(x, 2), round(y, 2)) for x, y in ring)))
                if key in seen_ring:                     # exact copy from the twin half-sheet
                    n_dup += 1
                    continue
                seen_ring.add(key)
                kept.append(ring)
            if not kept:
                continue
            xs = [p[0] for r in kept for p in r]
            ys = [p[1] for r in kept for p in r]
            rec = {
                "luokka": luokka,
                "rings": kept,
                "bbox": (min(xs), min(ys), max(xs), max(ys)),
            }
            if gid > 0:
                by_gid.setdefault(gid, []).append(rec)
            else:
                solo.append(rec)

    def touches(b1, b2, tol=0.5):
        return (b1[0] <= b2[2] + tol and b2[0] <= b1[2] + tol and
                b1[1] <= b2[3] + tol and b2[1] <= b1[3] + tol)

    merged = []
    n_joined = n_disjoint = 0
    for gid, recs in by_gid.items():
        groups = []
        for rec in recs:                                 # union-find over touching bboxes
            hit = [g for g in groups if any(touches(rec["bbox"], r["bbox"]) for r in g)]
            if not hit:
                groups.append([rec])
            else:
                hit[0].append(rec)
                for g in hit[1:]:
                    hit[0].extend(g)
                    groups.remove(g)
        if len(recs) > 1:
            if len(groups) < len(recs):
                n_joined += len(recs) - len(groups)
            if len(groups) > 1:
                n_disjoint += len(groups) - 1
        for g in groups:
            rings = [r for rec in g for r in rec["rings"]]
            merged.append((g[0]["luokka"], rings))
    for rec in solo:
        merged.append((rec["luokka"], rec["rings"]))
    print(f"building polygons: {n_raw} raw records, {n_dup} duplicate rings dropped, "
          f"{n_joined} boundary fragments unioned, {n_disjoint} same-id disjoint groups kept apart, "
          f"{len(merged)} physical buildings", flush=True)
    return merged


def buildings_to_records(merged):
    """Fit rects, project to the game frame, classify. Returns [[x,z,w,d,ang,cls],...]"""
    lat_min, lat_max, lon_min, lon_max = BBOX
    fits = []
    for luokka, rings in merged:
        area = abs(sum(ring_signed_area(r) for r in rings))
        if area < MIN_AREA:
            continue
        pts = [p for r in rings for p in r]
        cE, cN, w, d, th = min_area_rect(pts)
        fits.append((luokka, area, cE, cN, w, d, th))
    if not fits:
        return [], 0
    # batch inverse-project centre + one point along each rect axis
    E = np.empty(len(fits) * 3)
    N = np.empty(len(fits) * 3)
    for i, (_, _, cE, cN, w, d, th) in enumerate(fits):
        ux, uy = math.cos(th), math.sin(th)
        E[3 * i], N[3 * i] = cE, cN
        E[3 * i + 1], N[3 * i + 1] = cE + ux * w / 2, cN + uy * w / 2
        E[3 * i + 2], N[3 * i + 2] = cE - uy * d / 2, cN + ux * d / 2
    lon, lat = tm35fin_inv(E, N)
    X, Z = lonlat_to_world(lon, lat)
    out = []
    n_outside = 0
    for i, (luokka, area, _, _, _, _, _) in enumerate(fits):
        clon, clat = lon[3 * i], lat[3 * i]
        if not (lat_min <= clat <= lat_max and lon_min <= clon <= lon_max):
            n_outside += 1
            continue
        x0, z0 = X[3 * i], Z[3 * i]
        dxw, dzw = X[3 * i + 1] - x0, Z[3 * i + 1] - z0
        dxd, dzd = X[3 * i + 2] - x0, Z[3 * i + 2] - z0
        w = 2 * math.hypot(dxw, dzw)
        d = 2 * math.hypot(dxd, dzd)
        ang = math.atan2(-dzw, dxw)                     # rotateY convention (z = south)
        while ang >= math.pi / 2:
            ang -= math.pi
        while ang < -math.pi / 2:
            ang += math.pi
        if luokka in CLS_CHURCH:
            cls = 2
        elif area < SMALL_AREA or (luokka in CLS_OTHER and area < OTHER_SMALL_AREA):
            cls = 1
        else:
            cls = 0
        out.append([round(x0, 1), round(z0, 1),
                    max(0.1, round(w, 1)), max(0.1, round(d, 1)),
                    round(ang, 2), cls])
    return out, n_outside


# -------------------------------------------------------------------- merge
def merge_with_osm(nls, osm):
    """NLS is the base layer; keep an OSM record only when no NLS centre is
    within MERGE_R of it. Grid hash keeps this O(n)."""
    cell = MERGE_R
    grid = {}
    for b in nls:
        grid.setdefault((int(b[0] // cell), int(b[1] // cell)), []).append((b[0], b[1]))
    kept = []
    r2 = MERGE_R * MERGE_R
    for b in osm:
        cx, cz = int(b[0] // cell), int(b[1] // cell)
        twin = False
        for gx in (cx - 1, cx, cx + 1):
            for gz in (cz - 1, cz, cz + 1):
                for (nx, nz) in grid.get((gx, gz), ()):
                    if (nx - b[0]) ** 2 + (nz - b[1]) ** 2 <= r2:
                        twin = True
                        break
                if twin:
                    break
            if twin:
                break
        if not twin:
            kept.append(b)
    return kept


# ----------------------------------------------------------- sanity helpers
def island_by_name(islands, name):
    cands = [r for r in islands if r.get("n") == name]
    return max(cands, key=lambda r: r["a"]) if cands else None


def island_frame(rec):
    """(cx, cz, bbox) from an island ring (world coords, elevation-bake convention)."""
    pts = rec["p"]
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    return (sum(xs) / len(xs), sum(zs) / len(zs),
            (min(xs), min(zs), max(xs), max(zs)))


def count_in_bbox(buildings, bbox, z_min=None, z_max=None):
    n = 0
    for b in buildings:
        if bbox[0] <= b[0] <= bbox[2] and bbox[1] <= b[1] <= bbox[3]:
            if z_min is not None and not (b[1] > z_min):
                continue
            if z_max is not None and not (b[1] <= z_max):
                continue
            n += 1
    return n


def count_near(buildings, cx, cz, r):
    r2 = r * r
    return sum(1 for b in buildings if (b[0] - cx) ** 2 + (b[1] - cz) ** 2 <= r2)


# --------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default="public/archipelago_data.json")
    ap.add_argument("--map", default="public/archipelago_map.json")
    ap.add_argument("--cache", required=True, help="download cache dir (keep OUTSIDE the repo)")
    args = ap.parse_args()

    checks = []

    def gate(cond, msg):
        checks.append(cond)
        print(f"  {'OK ' if cond else 'FAIL'} {msg}", flush=True)

    # -- transform round trip must be trustworthy before anything else
    rng = np.random.default_rng(1234)
    lon = rng.uniform(BBOX[2], BBOX[3], 100)
    lat = rng.uniform(BBOX[0], BBOX[1], 100)
    E, N = tm35fin(lon, lat)
    lon2, lat2 = tm35fin_inv(E, N)
    rt_err = float(np.max(np.hypot((lon2 - lon) * M_LON, (lat2 - lat) * M_LAT)))
    print(f"TM35FIN inverse round-trip error (100 random bbox points): {rt_err:.2e} m", flush=True)
    if rt_err >= 0.5:
        sys.exit(f"FATAL: inverse transform round-trip error {rt_err} m >= 0.5 m")

    # -- download the half-sheet zips (cached; re-runs hit the cache only)
    cache_zip = os.path.join(args.cache, "zip")
    os.makedirs(cache_zip, exist_ok=True)
    sheets = sheets_for_bbox()
    leaf_names = sorted({s[0] for s in sheets})
    print(f"sheets: {len(leaf_names)} leaves / {len(sheets)} half-sheet zips: "
          f"{' '.join(leaf_names)}", flush=True)
    fetched = missing = 0
    dl_bytes = 0
    for name, half, rel in sheets:
        dest = os.path.join(cache_zip, f"{name}{half}.shp.zip")
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            continue
        res = fetch(BASE + rel, dest)
        if res == "ok":
            fetched += 1
            dl_bytes += os.path.getsize(dest)
            print(f"  {name}{half} {os.path.getsize(dest) / 1e6:.1f} MB", flush=True)
        elif res == "missing":
            missing += 1
            print(f"  {name}{half}: 404 (open sea?) — treated as empty", flush=True)
        else:
            sys.exit(f"FATAL: cannot fetch {rel} — refusing to bake from partial data")
    cached_bytes = sum(os.path.getsize(os.path.join(cache_zip, f"{n}{h}.shp.zip"))
                       for n, h, _ in sheets
                       if os.path.exists(os.path.join(cache_zip, f"{n}{h}.shp.zip")))
    print(f"downloads: {fetched} new ({dl_bytes / 1e6:.1f} MB), {missing} missing, "
          f"cache total {cached_bytes / 1e6:.1f} MB", flush=True)

    # -- parse + fit + project
    t0 = time.time()
    merged = collect_buildings(cache_zip, sheets)
    nls, n_outside = buildings_to_records(merged)
    print(f"NLS buildings in bbox: {len(nls)} (dropped {n_outside} outside bbox, "
          f"{len(merged) - len(nls) - n_outside} under {MIN_AREA} m^2) "
          f"[{time.time() - t0:.1f}s]", flush=True)
    cls_counts = {c: sum(1 for b in nls if b[5] == c) for c in (0, 1, 2)}
    print(f"NLS classes: {cls_counts[0]} buildings, {cls_counts[1]} small/outbuildings, "
          f"{cls_counts[2]} churches", flush=True)

    # -- merge with the existing (OSM) buildings
    raw = open(args.data).read()
    data = json.loads(raw)
    before = data["buildings"]

    # keep an honest OSM-only baseline for before/after reporting on re-runs
    baseline_path = os.path.join(args.cache, "buildings_before_nls.json")
    if os.path.exists(baseline_path):
        baseline = json.load(open(baseline_path))
    else:
        baseline = before
        with open(baseline_path, "w") as f:
            json.dump(baseline, f)

    kept = merge_with_osm(nls, before)
    final = sorted(nls + kept, key=lambda b: (b[0], b[1], b[2], b[3], b[4], b[5]))
    print(f"merge: {len(nls)} NLS + {len(kept)} kept of {len(before)} previous "
          f"(rest were NLS twins within {MERGE_R:.0f} m) = {len(final)} total", flush=True)
    if len(final) > MAX_TOTAL:
        sys.exit(f"FATAL: {len(final)} buildings > {MAX_TOTAL} — mainland sheets or "
                 f"non-building features ingested? refusing to write")

    # -- splice ONLY the buildings array into the raw JSON text
    key = '"buildings":'
    i0 = raw.index(key)
    j = raw.index("[", i0)
    depth = 0
    j1 = j
    while True:
        ch = raw[j1]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                break
        j1 += 1
    new_raw = raw[:j] + json.dumps(final, separators=(",", ":")) + raw[j1 + 1:]
    out_mb = len(new_raw) / 1e6
    if out_mb > MAX_JSON_MB:
        sys.exit(f"FATAL: output {out_mb:.2f} MB > {MAX_JSON_MB} MB budget")
    identical = new_raw == raw
    with open(args.data, "w") as f:
        f.write(new_raw)
    print(f"wrote {args.data}: {out_mb:.2f} MB"
          + (" (byte-identical to previous — idempotent re-run)" if identical else ""),
          flush=True)

    # -- sanity gates ------------------------------------------------------
    mapd = json.loads(open(args.map).read())
    islands = mapd["islands"]

    def counts_for(name):
        rec = island_by_name(islands, name)
        if rec is None:
            return None
        cx, cz, bbox = island_frame(rec)
        return {
            "before": count_in_bbox(baseline, bbox),
            "after": count_in_bbox(final, bbox),
            "cx": cx, "cz": cz, "bbox": bbox,
        }

    bisk = island_by_name(islands, "Biskopsö")
    print("\nvillage table (buildings with centre inside the island ring bbox):", flush=True)
    print(f"  {'island':<14} {'before':>7} {'after':>7}", flush=True)
    rows = {}
    if bisk is not None:
        cx, cz, bbox = island_frame(bisk)
        bs_before = count_in_bbox(baseline, bbox, z_min=cz)
        bs_after = count_in_bbox(final, bbox, z_min=cz)
        bn_before = count_in_bbox(baseline, bbox, z_max=cz)
        bn_after = count_in_bbox(final, bbox, z_max=cz)
        print(f"  {'Biskopsö S':<14} {bs_before:>7} {bs_after:>7}", flush=True)
        print(f"  {'Biskopsö N':<14} {bn_before:>7} {bn_after:>7}", flush=True)
        rows["bisk_s"] = bs_after
    for nm in ("Utö", "Nötö", "Jurmo", "Aspö"):
        c = counts_for(nm)
        if c is None:
            print(f"  {nm:<14} MISSING from map", flush=True)
        else:
            print(f"  {nm:<14} {c['before']:>7} {c['after']:>7}", flush=True)
            rows[nm] = c

    print("\nsanity gates:", flush=True)
    if bisk is None:
        gate(False, "Biskopsö island present in map")
    else:
        gate(rows.get("bisk_s", 0) >= 5,
             f"Biskopsö southern half: {rows.get('bisk_s', 0)} buildings (want >= 5)")
    uto = rows.get("Utö")
    if uto is None:
        gate(False, "Utö island present in map")
    else:
        n600 = count_near(final, uto["cx"], uto["cz"], 600.0)
        gate(n600 >= 150, f"Utö village: {n600} buildings within 600 m of centre (want >= 150)")
    gate(len(final) >= 10000, f"total buildings: {len(final)} (want >= 10000)")

    x_lo, _ = lonlat_to_world(BBOX[2], LAT0)
    x_hi, _ = lonlat_to_world(BBOX[3], LAT0)
    _, z_hi = lonlat_to_world(LON0, BBOX[0])
    _, z_lo = lonlat_to_world(LON0, BBOX[1])
    margin = 250.0                                       # pre-existing OSM sits a hair outside
    bad = [b for b in final if not (x_lo - margin <= b[0] <= x_hi + margin
                                    and z_lo - margin <= b[1] <= z_hi + margin)]
    gate(not bad, f"coords inside game-frame bounds x[{x_lo:.0f}..{x_hi:.0f}] "
                  f"z[{z_lo:.0f}..{z_hi:.0f}] (+{margin:.0f} m): {len(bad)} outside")

    check = json.loads(new_raw)
    same_rest = (json.dumps(check["nature"], separators=(",", ":")) ==
                 json.dumps(data["nature"], separators=(",", ":"))
                 and json.dumps(check["piers"], separators=(",", ":")) ==
                 json.dumps(data["piers"], separators=(",", ":"))
                 and json.dumps(check["seamarks"], separators=(",", ":")) ==
                 json.dumps(data["seamarks"], separators=(",", ":")))
    gate(same_rest, "nature/piers/seamarks unchanged")

    if not all(checks):
        print("\nSANITY FAILED — file written, but do not trust it", flush=True)
        sys.exit(1)
    print(f"\nall gates passed — {len(final)} buildings "
          f"({len(nls)} NLS + {len(kept)} OSM), {out_mb:.2f} MB", flush=True)
    print(CREDIT, flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Bake the world-expansion OSM prop delta: piers, seamarks, nature, roads.

The world grew from the original box (lat 59.70..60.20, lon 21.15..22.35)
to Uto -> Porvoo (lat 59.60..60.55, lon 21.00..25.95), but the OSM props in
public/archipelago_data.json (piers / seamarks / nature) and the highway
network in public/archipelago_roads.json still stopped at the old edge.
This script fetches ONLY the new territory (the expanded box minus the old
box, covered by four rectangles W/S/N/E) from Overpass and APPENDS the new
records to the existing arrays. Old records are never re-serialised: the
new JSON text is spliced in front of each array's closing bracket, so every
pre-existing byte stays byte-identical.

What is fetched and how it maps (verified by re-fetching the OLD box and
matching all 760 existing seamarks at < 0.07 m and reproducing 1085/1094
piers and ~1500/1812 nature polys byte-for-byte; the remainder is OSM edit
drift since the original bake):
  seamarks  node[seamark:type], record [x, z, t] (coords 1 decimal):
              buoy/beacon_lateral  category port -> 0, starboard -> 1
                                   (preferred_channel_port/starboard alike)
              buoy/beacon_cardinal north 2, east 3, south 4, west 5
              buoy/beacon_special_purpose -> 6
              light_major / light_minor   -> 7
              anything else (rocks, moorings, harbours...) skipped
  piers     way[man_made=pier] -> polyline (closed rings stay closed),
              RDP tol 2.0 m, coords 1 decimal, full way geometry kept
  nature    way[natural=wood]+way[landuse=forest] -> c0, natural=heath ->
              c1, natural=scrub -> c2 (ways only — the old bake ignored
              relations, so does this one). RDP tol 6.0 m, integer coords,
              tol grows x1.5 until <= 40 points (old cap), area floor 80 m^2
  roads     way[highway ~ primary|secondary|tertiary|unclassified|
              residential|service|track] (same classes as bake_roads.py,
              track included, footways not), c1 major / c0 minor, RDP 3.0,
              integer coords, runs < 30 m dropped

COASTAL FILTER: piers, nature and roads keep a record only if some point
lies within --coast-r (default 1200 m) of real coastline — island ring
edges plus mainland tiles' natural (non-q) edges from archipelago_map.json,
sampled every ~60 m. Inland Uusimaa is not a sailing destination. Seamarks
are charted in open water and are exempt. If a size budget trips, the
filter tightens (roads) or the nature area floor rises, loudly.

Overpass discipline: one query per ~0.19 x 0.30 deg tile (coast tiles get
the full union query, open-sea/inland tiles seamarks only), 180 s timeout,
429/504 backoff with endpoint alternation (overpass-api.de <-> kumi
mirror), adaptive tile splitting after repeated failures, every response
cached in --cache, cumulative-backoff stonewall abort. Re-runs are
network-free and detect the already-appended block (idempotent no-op).

Usage:
  python3 tools/bake_osm_props.py --cache /path/outside/repo
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_JSON = os.path.join(ROOT, "public", "archipelago_data.json")
ROADS_JSON = os.path.join(ROOT, "public", "archipelago_roads.json")
MAP_JSON = os.path.join(ROOT, "public", "archipelago_map.json")

# boxes are (s, w, n, e) in degrees
NEW_BBOX = (59.60, 21.00, 60.55, 25.95)
OLD_BBOX = (59.70, 21.15, 60.20, 22.35)
# the new territory = NEW_BBOX minus OLD_BBOX as four rectangles
RECTS = [
    ("W", (59.60, 21.00, 60.55, 21.15)),
    ("S", (59.60, 21.15, 59.70, 22.35)),
    ("N", (60.20, 21.15, 60.55, 22.35)),
    ("E", (59.60, 22.35, 60.55, 25.95)),
]
TILE_LAT = 0.19
TILE_LON = 0.30

LON0, LAT0 = 21.49, 59.805
KX = 111320 * math.cos(math.radians(59.805))
KZ = 111320.0

COAST_STEP = 60.0                     # m between coastline samples
PIER_TOL = 2.0                        # m RDP — reproduces the old bake
NATURE_TOL = 6.0                      # m RDP — reproduces the old bake
NATURE_MAX_PTS = 40                   # old bake's observed cap
NATURE_MIN_AREA = 80.0                # m^2 — old bake's observed floor (min 89)
ROAD_TOL = 3.0                        # m RDP — bake_roads.py default
ROAD_MIN_LEN = 30.0                   # m — bake_roads.py floor
PAD = 0.02                            # deg — bake_roads.py run padding
WPAD = 0.005                          # deg — allowed overshoot at the WORLD edge
OVERSHOOT_M = 2000.0                  # m — drop piers/nature reaching further out
DATA_BUDGET_MB = 2.2                  # data json after append (buildings rebake
                                      # later replaces the buildings array and
                                      # enforces the final 4.5 MB itself)
ROADS_BUDGET_MB = 2.2                 # roads json after append (8x world; gate 2.3)

HW_RE = "^(primary|secondary|tertiary|unclassified|residential|service|track)$"
MAJOR = {"primary", "secondary", "tertiary"}

ENDPOINTS = ["https://overpass-api.de/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter"]
UA = "archipelago-sunset-bake/1.0 (personal sailing-game project)"
STONEWALL_BUDGET = 20 * 60.0

_net = {"queries": 0, "cache_hits": 0, "retries": 0, "stonewall": 0.0,
        "endpoint_switches": 0, "throttle": 2.0, "splits": 0}


def proj(lon, lat):
    return (lon - LON0) * KX, -(lat - LAT0) * KZ


# ------------------------------------------------------------------ overpass
def overpass(query, cache_name, cache_dir, tries=3):
    """One disciplined Overpass query. Returns parsed JSON or None (so the
    caller can split the tile); cache-first, mirror alternation, backoff."""
    path = os.path.join(cache_dir, cache_name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            _net["cache_hits"] += 1
            return json.loads(f.read().decode("utf-8"))
    body = urllib.parse.urlencode({"data": query}).encode()
    ep = 0
    for attempt in range(tries):
        if _net["stonewall"] > STONEWALL_BUDGET:
            sys.exit(f"FATAL: Overpass stonewalled for >{STONEWALL_BUDGET/60:.0f} min; "
                     f"aborting instead of hammering. {_net['queries']} queries done, "
                     f"cache kept -- re-run resumes.")
        try:
            req = urllib.request.Request(ENDPOINTS[ep], data=body,
                                         headers={"User-Agent": UA})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=185) as r:
                raw = r.read()
            payload = json.loads(raw.decode("utf-8"))
            remark = payload.get("remark", "")
            if "error" in remark.lower() or "timed out" in remark.lower():
                raise RuntimeError(f"overpass remark: {remark[:120]}")
            with open(path, "wb") as f:
                f.write(raw)
            _net["queries"] += 1
            _net["stonewall"] = 0.0
            print(f"  fetched {cache_name}: {len(payload.get('elements', []))} elements, "
                  f"{len(raw)/1e6:.1f} MB, {time.time()-t0:.0f}s", flush=True)
            time.sleep(_net["throttle"])
            return payload
        except Exception as ex:
            _net["retries"] += 1
            code = getattr(ex, "code", None)
            if code in (429, 504):
                cool = 30.0 * (attempt + 1)
                _net["throttle"] = min(_net["throttle"] * 1.5, 20.0)
            else:
                cool = 15.0 * (attempt + 1)
            if attempt >= 1:
                ep = 1 - ep
                _net["endpoint_switches"] += 1
            print(f"  [{cache_name}] attempt {attempt+1} failed "
                  f"({code or type(ex).__name__}: {str(ex)[:80]}); cooling {cool:.0f}s",
                  flush=True)
            _net["stonewall"] += cool
            time.sleep(cool)
    return None


def tile_query(box, full):
    s, w, n, e = box
    bb = f"({s:.4f},{w:.4f},{n:.4f},{e:.4f})"
    if not full:
        return f'[out:json][timeout:180];node["seamark:type"]{bb};out;'
    return ("[out:json][timeout:180];("
            f'node["seamark:type"]{bb};'
            f'way["man_made"="pier"]{bb};'
            f'way["natural"~"^(wood|heath|scrub)$"]{bb};'
            f'way["landuse"="forest"]{bb};'
            f'way["highway"~"{HW_RE}"]{bb};'
            ");out geom;")


def fetch_tile(box, full, cache_dir, depth=0):
    """Fetch one tile, splitting into quadrants after repeated failure."""
    s, w, n, e = box
    name = f"props_{s:.4f}_{w:.4f}_{n:.4f}_{e:.4f}_{'full' if full else 'sea'}.json"
    payload = overpass(tile_query(box, full), name, cache_dir)
    if payload is not None:
        return payload.get("elements", [])
    if depth >= 3:
        sys.exit(f"FATAL: Overpass unusable for {name} even after splitting; "
                 f"no fake geometry substituted -- fix connectivity and re-run.")
    _net["splits"] += 1
    print(f"  splitting tile {name} (depth {depth+1})", flush=True)
    ms, mw = (s + n) / 2, (w + e) / 2
    out = []
    for q in ((s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)):
        out.extend(fetch_tile(q, full, cache_dir, depth + 1))
    return out


# ------------------------------------------------------------------ geometry
def rdp(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i0, i1 = stack.pop()
        x0, z0 = pts[i0]
        x1, z1 = pts[i1]
        dx, dz = x1 - x0, z1 - z0
        seg2 = dx * dx + dz * dz
        dmax, imax = -1.0, -1
        for i in range(i0 + 1, i1):
            px, pz = pts[i]
            if seg2 == 0.0:
                d = math.hypot(px - x0, pz - z0)
            else:
                d = abs(dx * (pz - z0) - dz * (px - x0)) / math.sqrt(seg2)
            if d > dmax:
                dmax, imax = d, i
        if dmax > tol:
            keep[imax] = True
            stack.append((i0, imax))
            stack.append((imax, i1))
    return [p for p, k in zip(pts, keep) if k]


def dedupe(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    return out


def shoelace2(pts):
    s = 0.0
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        s += x1 * z2 - x2 * z1
    return s


def polyline_len(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
               for i in range(len(pts) - 1))


def in_box(lat, lon, box):
    s, w, n, e = box
    return s <= lat <= n and w <= lon <= e


# ------------------------------------------------------------ coastal filter
def build_coast(mapd):
    """Grid hash of coast samples: island ring edges + mainland natural edges."""
    cell = 400.0
    grid = {}
    n_samp = 0
    for rec in mapd["islands"]:
        p = rec["p"]
        n = len(p)
        if n < 2:
            continue
        cut = set(rec.get("q") or ()) if rec.get("k") == "mainland" else ()
        for i in range(n):
            if i in cut:
                continue
            ax, az = p[i]
            bx, bz = p[(i + 1) % n]
            steps = max(1, int(math.hypot(bx - ax, bz - az) // COAST_STEP))
            for t in range(steps + 1):
                f = t / steps
                x, z = ax + (bx - ax) * f, az + (bz - az) * f
                grid.setdefault((int(x // cell), int(z // cell)), []).append((x, z))
                n_samp += 1
    print(f"coastline: {n_samp} samples @{COAST_STEP:.0f} m", flush=True)
    return grid


def coast_near(grid, x, z, r):
    cell = 400.0
    r2 = r * r
    for gx in range(int((x - r) // cell), int((x + r) // cell) + 1):
        for gz in range(int((z - r) // cell), int((z + r) // cell) + 1):
            for sx, sz in grid.get((gx, gz), ()):
                if (sx - x) ** 2 + (sz - z) ** 2 <= r2:
                    return True
    return False


def any_near(grid, pts, r):
    return any(coast_near(grid, x, z, r) for x, z in pts)


# --------------------------------------------------------------- tiling plan
def tiles_for(rect):
    s, w, n, e = rect
    nrows = max(1, round((n - s) / TILE_LAT))
    ncols = max(1, round((e - w) / TILE_LON))
    out = []
    for r in range(nrows):
        for c in range(ncols):
            out.append((s + (n - s) * r / nrows, w + (e - w) * c / ncols,
                        s + (n - s) * (r + 1) / nrows, w + (e - w) * (c + 1) / ncols))
    return out


def tile_has_coast(grid, box):
    """Any coast sample inside the tile (+2 km slack, so shore piers/roads
    just over the tile edge still get their tile fetched in full)."""
    s, w, n, e = box
    x0, z1 = proj(w, s)
    x1, z0 = proj(e, n)
    m = 2000.0
    cell = 400.0
    for gx in range(int((x0 - m) // cell), int((x1 + m) // cell) + 1):
        for gz in range(int((z0 - m) // cell), int((z1 + m) // cell) + 1):
            if (gx, gz) in grid:
                return True
    return False


# ------------------------------------------------------------- text splicing
def array_span(raw, key):
    """(start, end) indices of the [...] value of `key` in the raw JSON text."""
    i0 = raw.index(f'"{key}":')
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
    return j, j1


def append_into(raw, key, addition):
    """Splice `addition` (already-serialised records, no brackets) before the
    closing bracket of the `key` array. Existing bytes untouched."""
    if not addition:
        return raw
    j, j1 = array_span(raw, key)
    body = raw[j + 1:j1].strip()
    sep = "," if body else ""
    return raw[:j1] + sep + addition + raw[j1:]


# ---------------------------------------------------------------- processing
SEAMARK_LAT = {"port": 0, "preferred_channel_port": 0,
               "starboard": 1, "preferred_channel_starboard": 1}
SEAMARK_CARD = {"north": 2, "east": 3, "south": 4, "west": 5}


def classify_seamark(tags):
    st = tags.get("seamark:type", "")
    if st in ("buoy_lateral", "beacon_lateral"):
        return SEAMARK_LAT.get(tags.get(f"seamark:{st}:category", ""))
    if st in ("buoy_cardinal", "beacon_cardinal"):
        return SEAMARK_CARD.get(tags.get(f"seamark:{st}:category", ""))
    if st in ("buoy_special_purpose", "beacon_special_purpose"):
        return 6
    if st in ("light_major", "light_minor"):
        return 7
    return None


NAT_CLS = [("natural", "wood", 0), ("landuse", "forest", 0),
           ("natural", "heath", 1), ("natural", "scrub", 2)]


def classify_nature(tags):
    for k, v, c in NAT_CLS:
        if tags.get(k) == v:
            return c
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache", required=True, help="Overpass cache dir (OUTSIDE the repo)")
    ap.add_argument("--coast-r", type=float, default=1200.0)
    ap.add_argument("--data", default=DATA_JSON)
    ap.add_argument("--roads", default=ROADS_JSON)
    ap.add_argument("--map", default=MAP_JSON)
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    checks = []

    def gate(cond, msg):
        checks.append(cond)
        print(f"  {'OK ' if cond else 'FAIL'} {msg}", flush=True)

    raw_data = open(args.data).read()
    raw_roads = open(args.roads).read()
    data0 = json.loads(raw_data)
    roads0 = json.loads(raw_roads)

    mapd = json.loads(open(args.map).read())
    coast = build_coast(mapd)

    # ---- fetch the new territory, tile by tile
    all_tiles = []
    for rname, rect in RECTS:
        ts = tiles_for(rect)
        all_tiles.extend(ts)
        print(f"rect {rname} {rect}: {len(ts)} tiles", flush=True)
    n_full = n_sea = 0
    elements = []
    for box in all_tiles:
        full = tile_has_coast(coast, box)
        if full:
            n_full += 1
        else:
            n_sea += 1
        elements.extend(fetch_tile(box, full, args.cache))
    print(f"tiles: {n_full} coastal (full query) + {n_sea} sea/inland (seamarks only); "
          f"{_net['queries']} live queries, {_net['cache_hits']} cache hits, "
          f"{_net['retries']} retries, {_net['splits']} splits, "
          f"{_net['endpoint_switches']} endpoint switches", flush=True)

    # ---- dedupe by element id
    nodes, ways = {}, {}
    for el in elements:
        if el.get("type") == "node":
            nodes.setdefault(el["id"], el)
        elif el.get("type") == "way":
            ways.setdefault(el["id"], el)
    print(f"unique elements: {len(nodes)} nodes, {len(ways)} ways", flush=True)

    # world-bounds guards (game frame)
    wx0, wz1 = proj(NEW_BBOX[1], NEW_BBOX[0])
    wx1, wz0 = proj(NEW_BBOX[3], NEW_BBOX[2])

    def overshoot(pts):
        m = 0.0
        for x, z in pts:
            m = max(m, wx0 - x, x - wx1, wz0 - z, z - wz1)
        return m

    # ---- seamarks -------------------------------------------------------
    sea_new = []
    from collections import Counter
    sea_types = Counter()
    for nid in sorted(nodes):
        el = nodes[nid]
        lat, lon = el.get("lat"), el.get("lon")
        if lat is None or lon is None:
            continue
        if in_box(lat, lon, OLD_BBOX) or not in_box(lat, lon, NEW_BBOX):
            continue
        t = classify_seamark(el.get("tags", {}))
        if t is None:
            continue
        x, z = proj(lon, lat)
        sea_new.append([round(x, 1), round(z, 1), t])
        sea_types[t] += 1
    sea_new.sort(key=lambda r: (r[0], r[1], r[2]))
    print(f"seamarks: {len(sea_new)} new; types {dict(sorted(sea_types.items()))}", flush=True)

    # ---- piers ----------------------------------------------------------
    pier_new = []
    n_pier_old = n_pier_far = n_pier_deg = 0
    for wid in sorted(ways):
        el = ways[wid]
        if el.get("tags", {}).get("man_made") != "pier" or not el.get("geometry"):
            continue
        geo = el["geometry"]
        if any(in_box(g["lat"], g["lon"], OLD_BBOX) for g in geo):
            n_pier_old += 1                      # already in the old bake's data
            continue
        pts = [proj(g["lon"], g["lat"]) for g in geo]
        if overshoot(pts) > OVERSHOOT_M:
            n_pier_far += 1
            continue
        simp = dedupe([[round(x, 1), round(z, 1)] for x, z in rdp(pts, PIER_TOL)])
        if len(simp) < 2:
            n_pier_deg += 1
            continue
        if not any_near(coast, simp, args.coast_r):
            n_pier_far += 1
            continue
        pier_new.append(simp)
    pier_new.sort(key=lambda p: (p[0][0], p[0][1], len(p)))
    print(f"piers: {len(pier_new)} new ({n_pier_old} already in old box, "
          f"{n_pier_far} off-world/inland, {n_pier_deg} degenerate)", flush=True)

    # ---- nature ---------------------------------------------------------
    def bake_nature(min_area):
        out = []
        n_old = n_small = n_far = 0
        for wid in sorted(ways):
            el = ways[wid]
            c = classify_nature(el.get("tags", {}))
            if c is None or not el.get("geometry"):
                continue
            geo = el["geometry"]
            if any(in_box(g["lat"], g["lon"], OLD_BBOX) for g in geo):
                n_old += 1
                continue
            pts = [proj(g["lon"], g["lat"]) for g in geo]
            if overshoot(pts) > OVERSHOOT_M:
                n_far += 1
                continue
            tol = NATURE_TOL
            for _ in range(9):
                simp = dedupe([[int(round(x)), int(round(z))] for x, z in rdp(pts, tol)])
                if len(simp) <= NATURE_MAX_PTS:
                    break
                tol *= 1.5
            if len(simp) < 4:
                n_small += 1
                continue
            ring = simp[:-1] if simp[0] == simp[-1] else simp
            if len(ring) < 3 or abs(shoelace2(ring)) / 2.0 < min_area:
                n_small += 1
                continue
            if not any_near(coast, simp, args.coast_r):
                n_far += 1
                continue
            out.append({"c": c, "p": simp})
        out.sort(key=lambda r: (r["c"], r["p"][0][0], r["p"][0][1], len(r["p"])))
        return out, n_old, n_small, n_far

    nature_floor = NATURE_MIN_AREA
    nature_new, nn_old, nn_small, nn_far = bake_nature(nature_floor)
    print(f"nature: {len(nature_new)} new @floor {nature_floor:.0f} m^2 "
          f"({nn_old} old-box, {nn_small} small/degenerate, {nn_far} inland/off-world)",
          flush=True)

    # ---- roads ----------------------------------------------------------
    # keep window: inside world+WPAD, outside old-box core (old box shrunk by
    # PAD — the old bake itself overshoots its box by up to PAD, so the seam
    # keeps a hair of overlap instead of a gap)
    ob = (OLD_BBOX[0] + PAD, OLD_BBOX[1] + PAD, OLD_BBOX[2] - PAD, OLD_BBOX[3] - PAD)
    wb = (NEW_BBOX[0] - WPAD, NEW_BBOX[1] - WPAD, NEW_BBOX[2] + WPAD, NEW_BBOX[3] + WPAD)
    road_runs = []
    n_road_short = 0
    for wid in sorted(ways):
        el = ways[wid]
        hw = el.get("tags", {}).get("highway", "")
        if not el.get("geometry") or hw not in MAJOR and hw not in (
                "unclassified", "residential", "service", "track"):
            continue
        c = 1 if hw in MAJOR else 0
        runs, cur = [], []
        for g in el["geometry"]:
            la, lo = g["lat"], g["lon"]
            if in_box(la, lo, wb) and not in_box(la, lo, ob):
                cur.append(proj(lo, la))
            elif cur:
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        for run in runs:
            if len(run) < 2:
                continue
            simp = dedupe([[int(round(x)), int(round(z))] for x, z in rdp(run, ROAD_TOL)])
            if len(simp) < 2 or polyline_len(simp) < ROAD_MIN_LEN:
                n_road_short += 1
                continue
            road_runs.append({"c": c, "p": simp})
    road_runs.sort(key=lambda r: (r["p"][0][0], r["p"][0][1], r["c"], len(r["p"])))

    def roads_at(r):
        return [rr for rr in road_runs if any_near(coast, rr["p"], r)]

    road_r = args.coast_r
    roads_new = roads_at(road_r)
    print(f"roads: {len(road_runs)} runs in new territory, {len(roads_new)} within "
          f"{road_r:.0f} m of coast ({n_road_short} short dropped)", flush=True)

    # ---- idempotency: is the delta already in the files? -----------------
    # piers and seamarks do not depend on the adaptive knobs (nature floor,
    # road radius), so their serialised block is a reliable fingerprint of a
    # previous append; the adaptive arrays are then trusted to match too
    # (identical inputs walk the identical escalation path).
    add_sea = ",".join(json.dumps(r, separators=(",", ":")) for r in sea_new)
    add_pier = ",".join(json.dumps(r, separators=(",", ":")) for r in pier_new)

    def nature_add(nat):
        return ",".join(json.dumps(r, separators=(",", ":")) for r in nat)

    def roads_add(rr):
        return ",".join(json.dumps(r, separators=(",", ":")) for r in rr)

    already_data = bool(add_sea or add_pier) and \
                   (not add_sea or add_sea in raw_data) and \
                   (not add_pier or add_pier in raw_data)

    # ---- write data json (piers + seamarks + nature) ---------------------
    if already_data:
        print("data: delta already appended — no-op (idempotent re-run)", flush=True)
        new_data_raw = raw_data
        nature_used = None
    else:
        while True:
            add_nat = nature_add(nature_new)
            new_data_raw = raw_data
            new_data_raw = append_into(new_data_raw, "piers", add_pier)
            new_data_raw = append_into(new_data_raw, "seamarks", add_sea)
            new_data_raw = append_into(new_data_raw, "nature", add_nat)
            mb = len(new_data_raw) / 1e6
            if mb <= DATA_BUDGET_MB or nature_floor >= 500:
                break
            nature_floor *= 1.8
            nature_new, nn_old, nn_small, nn_far = bake_nature(nature_floor)
            print(f"data would be {mb:.2f} MB > {DATA_BUDGET_MB} MB pre-buildings budget — "
                  f"nature floor raised to {nature_floor:.0f} m^2 -> {len(nature_new)} polys",
                  flush=True)
        nature_used = nature_floor
        with open(args.data, "w") as f:
            f.write(new_data_raw)
        print(f"wrote {args.data}: {len(new_data_raw)/1e6:.2f} MB "
              f"(+{len(pier_new)} piers, +{len(sea_new)} seamarks, "
              f"+{len(nature_new)} nature @floor {nature_floor:.0f})", flush=True)

    # ---- write roads json -------------------------------------------------
    # detection replays the same radius ladder, so whichever radius a prior
    # run settled on is recognised exactly
    already_roads = False
    for r_try in (args.coast_r, 800.0, 600.0):
        blk = roads_add(roads_at(r_try))
        if blk and blk in raw_roads:
            already_roads = True
            roads_new = roads_at(r_try)
            break
    if already_roads:
        print("roads: delta already appended — no-op (idempotent re-run)", flush=True)
        new_roads_raw = raw_roads
        road_r_used = None
    else:
        # ladder: keep MAJOR roads (c=1, the legible arterial skeleton) always;
        # drop short MINOR side streets first (the 260/region renderer never
        # shows them), then tighten the coastal radius. minlen filters minor
        # runs by length; major runs are exempt.
        LADDER = [(args.coast_r, 0), (args.coast_r, 150), (args.coast_r, 350),
                  (args.coast_r, 700), (800.0, 700), (600.0, 700), (600.0, 1e9)]
        road_r_used = args.coast_r
        for road_r, minlen in LADDER:
            roads_new = [rr for rr in roads_at(road_r)
                         if rr["c"] == 1 or polyline_len(rr["p"]) >= minlen]
            new_roads_raw = append_into(raw_roads, "roads", roads_add(roads_new))
            mb = len(new_roads_raw) / 1e6
            road_r_used = road_r
            if mb <= ROADS_BUDGET_MB:
                break
            print(f"roads {mb:.2f} MB > {ROADS_BUDGET_MB} MB — tightening "
                  f"(radius {road_r:.0f} m, drop minor < {minlen:.0f} m)", flush=True)
        if mb > ROADS_BUDGET_MB:
            sys.exit(f"FATAL: roads {mb:.2f} MB > {ROADS_BUDGET_MB} MB even at 600 m / majors only")
        with open(args.roads, "w") as f:
            f.write(new_roads_raw)
        print(f"wrote {args.roads}: {mb:.2f} MB "
              f"(+{len(roads_new)} ways @coast {road_r:.0f} m)", flush=True)

    # ---- sanity gates ------------------------------------------------------
    print("\nsanity gates:", flush=True)
    d1 = json.loads(new_data_raw)
    r1 = json.loads(new_roads_raw)
    gate(d1["piers"][:len(data0["piers"])] == data0["piers"]
         and d1["seamarks"][:len(data0["seamarks"])] == data0["seamarks"]
         and d1["nature"][:len(data0["nature"])] == data0["nature"]
         and d1["buildings"] == data0["buildings"],
         "old data records identical (prefix property)")
    gate(r1["roads"][:len(roads0["roads"])] == roads0["roads"],
         "old road records identical (prefix property)")
    n_new_p = len(d1["piers"]) - len(data0["piers"]) if not already_data else len(pier_new)
    n_new_s = len(d1["seamarks"]) - len(data0["seamarks"]) if not already_data else len(sea_new)
    n_new_n = len(d1["nature"]) - len(data0["nature"]) if not already_data else len(nature_new)
    n_new_r = len(r1["roads"]) - len(roads0["roads"]) if not already_roads else len(roads_new)
    gate(len(pier_new) > 60, f"new piers: {len(pier_new)} (want > 60)")
    gate(len(sea_new) > 120, f"new seamarks: {len(sea_new)} (want > 120)")
    gate(len(nature_new) > 200, f"new nature polys: {len(nature_new)} (want > 200)")
    gate(len(roads_new) > 400, f"new road ways: {len(roads_new)} (want > 400)")

    def arr_overshoot(pts_iter):
        m = 0.0
        for pts in pts_iter:
            m = max(m, overshoot(pts))
        return m

    gate(arr_overshoot([[(s[0], s[1])] for s in d1["seamarks"]]) <= 0.1,
         "seamarks inside world bbox")
    gate(arr_overshoot(d1["piers"]) <= OVERSHOOT_M,
         f"piers within world+{OVERSHOOT_M:.0f} m")
    gate(arr_overshoot([n["p"] for n in d1["nature"]]) <= OVERSHOOT_M,
         f"nature within world+{OVERSHOOT_M:.0f} m")
    gate(arr_overshoot([r["p"] for r in r1["roads"]]) <= 600.0,
         "roads within world+600 m")
    gate(len(new_data_raw) / 1e6 <= 8.0,
         f"data json {len(new_data_raw)/1e6:.2f} MB <= 8.0 MB")
    gate(len(new_roads_raw) / 1e6 <= 2.3,
         f"roads json {len(new_roads_raw)/1e6:.2f} MB <= 2.3 MB")

    if not all(checks):
        print("\nSANITY FAILED — files written, but do not trust them", flush=True)
        sys.exit(1)
    print(f"\nall gates passed — +{n_new_p} piers, +{n_new_s} seamarks, "
          f"+{n_new_n} nature, +{n_new_r} roads"
          + (f" (nature floor {nature_used:.0f} m^2)" if nature_used else "")
          + (f" (roads coast {road_r_used:.0f} m)" if road_r_used else ""), flush=True)
    print("props from OpenStreetMap (ODbL) via Overpass; new territory only, "
          "old records byte-identical", flush=True)


if __name__ == "__main__":
    main()

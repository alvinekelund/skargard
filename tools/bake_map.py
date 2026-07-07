#!/usr/bin/env python3
"""Bake the ÅLAND-EXTENDED archipelago map from OSM coastline data.

World: the whole south-west Finnish coast INCLUDING the full Åland Islands,
    bbox lat 59.60..60.55, lon 19.05..25.95   (Märket -> Porvoo)
replacing the previous expanded box (59.60..60.55, 21.00..25.95), which in
turn replaced the original Archipelago Sea box (59.70..60.20, 21.15..22.35).

Outputs (NO elevation yet -- a follow-up bake adds e/g; public/ untouched):
  <scratch>/map_aland_raw.json      {center, scale, islands} exactly in the
                                    record format of public/archipelago_map.json
  <scratch>/cover_remap_aland.json  {oldIslandIndex: newIslandIndex} from the
                                    CURRENT SHIPPING public/archipelago_map.json
                                    record order to the new order, so the
                                    satellite land-cover file (keyed by island
                                    index in map order) can be re-keyed

Record format (replicated from public/archipelago_map.json, verified):
  islands are sorted by area DESC; ring "p" is GLOBAL game-frame integer
  metres (x = (lon-21.49)*111320*cos(59.805 deg), z = -(lat-59.805)*111320),
  wound CW in the xz frame (= CCW geographic), first vertex NOT repeated;
  "a" = shoelace area of the FULL-resolution ring (pre-simplification), int;
  "k" in {"bald","sparse","forest"} by area (<10k / <115k / >=115k m^2) with
  the treeless outer-sea exceptions Jurmo + Uto forced to "sparse";
  "n" = name where known.

MAINLAND coast tiles (Hanko peninsula, Helsinki, Porvoo):
  open coastline chains are closed against the bbox with the classic
  walk-the-box algorithm (OSM coastline has water on the RIGHT of the
  way direction), then cut into 8x8 km game-frame axis-aligned cells
  (Sutherland-Hodgman).  Each non-empty cell piece becomes one island record:
    k = "mainland"  (distinct from every normal-island kind; this exact
             string is what src/archipelago.js already special-cases)
    q = sorted list of ring-vertex indices i such that edge i -> (i+1)%n lies
        ON a clip line (cell grid line x/z = k*8000 m, or a bbox boundary
        line) rather than on real coast; the runtime uses q to skip shoreline
        rendering on artificial seams.  Only NATURAL edges are RDP-
        simplified; cut-edge endpoints are never moved.  Slivers < 20,000 m^2
        are dropped.  Inland lakes/lagoon rings are DISCARDED (a sailing game
        needs no inland water).

NEW in this bake -- BIG-RING tiling + the Åland west strip:
  * any CLOSED land ring with area > BIG_RING_MIN_M2 (550 km^2 -- that is
    Fasta Åland at ~685 km^2 and nothing else; Kimitoön at ~548 km^2 stays a
    single island record) gets the SAME 8 km clip-tile treatment as the
    mainland: k="mainland", q cut-edge masks, slivers dropped.  The landmass
    NAME goes on exactly ONE tile -- the piece whose bbox contains (or is
    nearest to) the landmass area centroid -- so the map label and the HUD
    location still work; all other tiles stay unnamed.
  * SWEDEN CLIP: the bbox's SW corner reaches Swedish waters (Söderarm
    skerries ~19.4E 59.75N; Understen stays west of the box).  Rings built
    from Swedish coastline ways (per one cached Overpass admin-area query)
    are dropped -- except Märket (19.13E 60.30N), the half-Finnish
    half-Swedish lighthouse rock, which is kept whole on purpose.
  * open chains living ENTIRELY west of lon 20.60 are dropped before the
    mainland box-walk: there is no legitimate mainland there (only Swedish
    fetch-margin fragments / broken strip rings), and a stray fragment would
    otherwise fabricate land along the west bbox edge.

Cache-compat fetching: the previous run's Overpass tiles are reused verbatim.
The legacy fetch region (lon 20.70..26.25 = old bbox + margin) keeps its
exact tile grid and cache names (coast_r{r}_c{c}.json, names_c{i}.json); only
the NEW WEST strip (18.75..20.70) is fetched fresh under coastw_*/namesw_*
names.  Legacy tiles are ingested FIRST so shared ways keep the cached
geometry -- old-area output stays bit-identical to the shipping map.

Network discipline (Overpass): ~0.5 x 0.3 deg tiles, one query at a time,
180 s timeout, short sleep between live queries, every response cached in
the scratch dir and re-used on re-run (idempotent; re-run does zero
network), 429/504 honoured with backoff, mirror fallback, and a hard
15-minute stonewall budget after which the script reports and aborts
instead of hammering.
"""

import hashlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------- constants
SCRATCH = ("/private/tmp/claude-501/-Users-alvinjobb-Projects-github-portfolio/"
           "88c16174-e79a-426d-a54a-ecf150c78848/scratchpad")
CACHE = os.path.join(SCRATCH, "overpass_coast")
OUT_MAP = os.path.join(SCRATCH, "map_aland_raw.json")
OUT_REMAP = os.path.join(SCRATCH, "cover_remap_aland.json")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD_MAP = os.path.join(ROOT, "public", "archipelago_map.json")

# projection -- MUST match every other bake and the runtime satellite drape
LAT0, LON0 = 59.805, 21.49
KZ = 111320.0
KX = 111320.0 * math.cos(math.radians(LAT0))

# the world bbox (s, w, n, e): west edge extended to take in the FULL Åland
# Islands (Eckerö, all of Fasta Åland, the outer skerries, and Märket at
# 19.13E).  LEGACY_BBOX is the previous run's box -- it pins the legacy
# Overpass cache tile grid so the old area re-processes from cache,
# bit-identical.  Only the WEST edge may differ from LEGACY_BBOX (asserted
# below): moving any other edge would need its own new fetch region.
BBOX = (59.60, 19.05, 60.55, 25.95)
LEGACY_BBOX = (59.60, 21.00, 60.55, 25.95)
MARGIN = 0.30
FETCH = (BBOX[0] - MARGIN, BBOX[1] - MARGIN, BBOX[2] + MARGIN, BBOX[3] + MARGIN)
LEGACY_FETCH = (LEGACY_BBOX[0] - MARGIN, LEGACY_BBOX[1] - MARGIN,
                LEGACY_BBOX[2] + MARGIN, LEGACY_BBOX[3] + MARGIN)
assert BBOX[0] == LEGACY_BBOX[0] and BBOX[2] == LEGACY_BBOX[2] \
    and BBOX[3] == LEGACY_BBOX[3] and BBOX[1] <= LEGACY_BBOX[1], \
    "only a WEST extension is cache-compatible with the legacy tile grid"

# Overpass
ENDPOINTS = ["https://overpass-api.de/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter"]
UA = "archipelago-sunset-bake/1.0 (personal sailing-game project)"
TILE_LON, TILE_LAT = 0.555, 0.31          # legacy grid: 10 x 5 = 50 tiles
QUERY_SLEEP = 5.0                          # s between live queries
STONEWALL_BUDGET = 15 * 60.0               # s of CONSECUTIVE failure waiting

# coastline fetch regions: (cache_prefix, fetch_box).  LEGACY FIRST -- way
# dedup keeps the first copy seen, so ways shared across the region seam
# keep the cached (old-run) geometry.  Same for the name regions below.
COAST_REGIONS = [("coast", LEGACY_FETCH)]
NAME_REGIONS = [("names_c", (LEGACY_FETCH[1], LEGACY_FETCH[3]), 3)]
if BBOX[1] < LEGACY_BBOX[1]:
    WEST_FETCH = (FETCH[0], FETCH[1], FETCH[2], LEGACY_FETCH[1])
    COAST_REGIONS.append(("coastw", WEST_FETCH))
    NAME_REGIONS.append(("namesw_c", (WEST_FETCH[1], WEST_FETCH[3]), 1))

# classification (inferred from the current file: bald<10k<=sparse<115k<=forest,
# with the famously treeless Jurmo & Uto forced to sparse despite their size).
# Anchored to fixed game-frame points: the shipping map now contains TWO named
# Jurmos (Korpo's treeless one AND Brändö's larger, forested one), so the old
# max-area match would flip the wrong island.
KIND_BALD_MAX = 10_000
KIND_SPARSE_MAX = 115_000
FORCED_SPARSE = {"Jurmo": (6165.0, -2302.0), "Utö": (-6627.0, 2757.0)}
# src/archipelago.js line ~800 already implements the mainland contract:
#   const cut = rec.q && rec.q.length ? new Set(rec.q) : null;
#   const kind = rec.k === 'mainland' ? 'forest' : rec.k;
# so the distinct kind value for mainland tiles is the STRING "mainland"
# (never used by normal islands), not an integer.
MAINLAND_K = "mainland"

AREA_MIN = 50                              # m^2, floor seen in the current file
CELL = 8000.0                              # mainland tile size, m
SLIVER = 20_000.0                          # m^2, drop smaller mainland pieces
HEAL_DIST = 250.0                          # m, endpoint snap for OSM gaps

# big-ring tiling: closed rings above this area get the mainland clip-tile
# treatment.  550 km^2 catches Fasta Åland (~685 km^2) and NOTHING else --
# the runner-up, Kimitoön, measures 547,952,121 m^2 full-res (0.4 % below
# the line; safe while its ring reprocesses from the same cache).
BIG_RING_MIN_M2 = 550e6

# Sweden clip: admin-area query box for Swedish coastline ways (SW corner of
# the world box up to Märket's latitude band), the Märket keep-radius, and a
# geometric fallback zone (west of lon 19.62, south of lat 60.05 -- Söderarm
# waters; no Finnish land lives there) if the area query yields nothing.
SWEDEN_BOX = (59.50, 18.90, 60.55, 19.90)
MARKET_LL = (60.3007, 19.1312)             # lat, lon of the Märket rock
MARKET_KEEP_M = 1500.0
SWEDEN_FALLBACK_LON, SWEDEN_FALLBACK_LAT = 19.62, 60.05
WEST_CHAIN_GUARD_LON = 20.60               # opens entirely W of this: dropped

# RDP tolerances by pre-simplification area (m -> m^2 buckets); the tune loop
# scales the small buckets first (f_small), then everything (f_all)
TOL_TABLE = [(2_000, 5.0), (10_000, 8.0), (115_000, 14.0),
             (1_000_000, 25.0), (10_000_000, 40.0), (float("inf"), 55.0)]
SMALL_BUCKETS = 3                          # first N buckets scale with f_small
MAINLAND_TOL = 15.0                        # m, natural mainland edges
MAX_MB = 12.5                              # start tuning above this (tuning
                                           # would break old-area identity, so
                                           # the budget is deliberately roomy)
HARD_MAX_MB = 13.0                         # gate

# sanity-gate anchors (game-frame approx centroids, disambiguating duplicate
# names: e.g. Jurmo-of-Korpo vs Jurmo-of-Brändö) and the Åland name roster
BENCHMARKS = {"Jurmo": (5710.0, -2054.0), "Utö": (-6627.0, 2757.0),
              "Nötö": (14828.0, -16667.0), "Biskopsö": (24453.0, -40632.0),
              "Storlandet": (17847.0, -41505.0)}
ALAND_NAMES = ["Eckerö", "Lemland", "Lumparland", "Vårdö", "Kumlinge",
               "Kökar", "Föglö", "Sottunga", "Brändö", "Märket", "Lågskär"]

EPS = 1e-9

_net = {"queries": 0, "cache_hits": 0, "retries": 0, "stonewall": 0.0,
        "endpoint_switches": 0, "throttle": QUERY_SLEEP}


def proj(lon, lat):
    return (lon - LON0) * KX, -(lat - LAT0) * KZ


# game-frame rect of the (unextended) bbox; note z is NEGATED latitude
XW, _ = proj(BBOX[1], 0)
XE, _ = proj(BBOX[3], 0)
_, ZN = proj(0, BBOX[2])                   # north edge -> smaller (negative) z
_, ZS = proj(0, BBOX[0])                   # south edge -> larger z
RECT = (XW, XE, ZN, ZS)


# ---------------------------------------------------------------- overpass
def overpass(query, cache_name):
    """One disciplined Overpass query: cache-first, retry/backoff, mirror
    fallback, honest failure. Returns the parsed JSON."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, cache_name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            _net["cache_hits"] += 1
            return json.loads(f.read().decode("utf-8"))

    body = urllib.parse.urlencode({"data": query}).encode()
    ep = 0
    for attempt in range(6):
        if _net["stonewall"] > STONEWALL_BUDGET:
            sys.exit(f"FATAL: Overpass stonewalled for >{STONEWALL_BUDGET/60:.0f} min "
                     f"(cumulative backoff); aborting instead of hammering. "
                     f"{_net['queries']} queries done, cache kept -- re-run resumes.")
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
            _net["stonewall"] = 0.0        # progress resets the stonewall clock
            print(f"  fetched {cache_name}: {len(payload.get('elements', []))} elements, "
                  f"{len(raw)/1e6:.1f} MB, {time.time()-t0:.0f}s", flush=True)
            time.sleep(_net["throttle"])   # be nice between LIVE queries only
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
                ep = 1 - ep                 # alternate endpoints: whichever of
                _net["endpoint_switches"] += 1   # the two recovers first wins
                print(f"  [{cache_name}] switching to "
                      f"{'mirror' if ep else 'primary'}", flush=True)
            print(f"  [{cache_name}] attempt {attempt+1} failed "
                  f"({code or type(ex).__name__}: {str(ex)[:90]}); cooling {cool:.0f}s",
                  flush=True)
            _net["stonewall"] += cool
            time.sleep(cool)
    sys.exit(f"FATAL: Overpass unusable for {cache_name} after retries+mirror; "
             f"no fake geometry substituted -- fix connectivity and re-run.")


def fetch_coastline():
    """All natural=coastline ways over every fetch region, tiled, deduped by
    id (first region wins -- legacy cache geometry is authoritative for ways
    shared across the region seam).  Returns {way_id: (first_node, last_node,
    [(x,z)...], name_or_None, place_or_None)} in game-frame floats."""
    ways = {}
    tiles = 0
    for prefix, fbox in COAST_REGIONS:
        s0, w0, n0, e0 = fbox
        ncols = max(1, round((e0 - w0) / TILE_LON))
        nrows = max(1, round((n0 - s0) / TILE_LAT))
        dlon = (e0 - w0) / ncols
        dlat = (n0 - s0) / nrows
        for r in range(nrows):
            for c in range(ncols):
                s, n = s0 + r * dlat, s0 + (r + 1) * dlat
                w, e = w0 + c * dlon, w0 + (c + 1) * dlon
                q = (f"[out:json][timeout:180];"
                     f'way["natural"="coastline"]({s:.4f},{w:.4f},{n:.4f},{e:.4f});'
                     f"out geom;")
                data = overpass(q, f"{prefix}_r{r}_c{c}.json")
                tiles += 1
                for el in data.get("elements", []):
                    if el.get("type") != "way" or el["id"] in ways:
                        continue
                    nodes = el.get("nodes") or []
                    geom = el.get("geometry") or []
                    if len(nodes) < 2 or len(geom) != len(nodes) or any(
                            g is None for g in geom):
                        continue
                    pts = [proj(g["lon"], g["lat"]) for g in geom]
                    tags = el.get("tags") or {}
                    ways[el["id"]] = (nodes[0], nodes[-1], pts,
                                      tags.get("name"), tags.get("place"))
    print(f"coastline: {tiles} tiles, {len(ways)} unique ways", flush=True)
    return ways


def fetch_names():
    """place=island/islet relations + ways + nodes with names, per region
    (legacy: 3 lon chunks with their original cache names; west strip: 1)."""
    s0, n0 = FETCH[0], FETCH[2]
    els, seen = [], set()
    for prefix, (w0, e0), nchunks in NAME_REGIONS:
        for i in range(nchunks):
            w = w0 + i * (e0 - w0) / nchunks
            e = w0 + (i + 1) * (e0 - w0) / nchunks
            q = (f"[out:json][timeout:180];("
                 f'relation["place"~"^(island|islet)$"]["name"]({s0:.4f},{w:.4f},{n0:.4f},{e:.4f});'
                 f'way["place"~"^(island|islet)$"]["name"]({s0:.4f},{w:.4f},{n0:.4f},{e:.4f});'
                 f'node["place"~"^(island|islet)$"]["name"]({s0:.4f},{w:.4f},{n0:.4f},{e:.4f});'
                 f");out center;")
            data = overpass(q, f"{prefix}{i}.json")
            for el in data.get("elements", []):
                key = (el.get("type"), el.get("id"))
                if key in seen:
                    continue
                seen.add(key)
                els.append(el)
    print(f"names: {len(els)} place elements", flush=True)
    return els


def fetch_swedish_ways():
    """Ids of natural=coastline ways inside SWEDEN (admin area) within the
    SW guard box.  Used to clip Swedish skerries (Söderarm group) out of the
    world; Märket is exempted by the caller.  One cached query."""
    s, w, n, e = SWEDEN_BOX
    q = (f"[out:json][timeout:180];"
         f'area["ISO3166-1"="SE"][admin_level=2]->.se;'
         f'way["natural"="coastline"](area.se)({s:.4f},{w:.4f},{n:.4f},{e:.4f});'
         f"out ids;")
    data = overpass(q, "sweden_coast_ways.json")
    ids = {el["id"] for el in data.get("elements", [])
           if el.get("type") == "way"}
    print(f"sweden: {len(ids)} Swedish coastline ways in the guard box"
          + ("" if ids else "  [EMPTY -- geometric fallback zone active]"),
          flush=True)
    return ids


# ---------------------------------------------------------------- geometry
def shoelace2(ring):
    """Twice the signed area (game xz frame; islands come out NEGATIVE)."""
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        s += x1 * z2 - x2 * z1
    return s


def area_centroid(ring):
    """Area-weighted centroid -- robust to vertex spacing (unlike the vertex
    mean), so it identifies the same island across different simplifications."""
    a2 = 0.0
    cx = cz = 0.0
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        cr = x1 * z2 - x2 * z1
        a2 += cr
        cx += (x1 + x2) * cr
        cz += (z1 + z2) * cr
    if abs(a2) < 1e-9:
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        return sum(xs) / n, sum(zs) / n
    return cx / (3 * a2), cz / (3 * a2)


def pip(x, z, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        if (z1 > z) != (z2 > z):
            xx = (x2 - x1) * (z - z1) / (z2 - z1) + x1
            if x < xx:
                inside = not inside
    return inside


def seg_hits_rect(p, q, rect):
    """Liang-Barsky: does segment p-q intersect the axis-aligned rect?"""
    xw, xe, zn, zs = rect
    t0, t1 = 0.0, 1.0
    dx, dz = q[0] - p[0], q[1] - p[1]
    for pk, qk in ((-dx, p[0] - xw), (dx, xe - p[0]),
                   (-dz, p[1] - zn), (dz, zs - p[1])):
        if abs(pk) < EPS:
            if qk < 0:
                return False
            continue
        t = qk / pk
        if pk < 0:
            if t > t1:
                return False
            t0 = max(t0, t)
        else:
            if t < t0:
                return False
            t1 = min(t1, t)
    return t0 <= t1


def ring_intersects_rect(ring, rect):
    xw, xe, zn, zs = rect
    bx0 = min(p[0] for p in ring); bx1 = max(p[0] for p in ring)
    bz0 = min(p[1] for p in ring); bz1 = max(p[1] for p in ring)
    if bx1 < xw or bx0 > xe or bz1 < zn or bz0 > zs:
        return False
    for x, z in ring:
        if xw <= x <= xe and zn <= z <= zs:
            return True
    for cx, cz in ((xw, zn), (xw, zs), (xe, zn), (xe, zs)):
        if pip(cx, cz, ring):
            return True
    n = len(ring)
    for i in range(n):
        if seg_hits_rect(ring[i], ring[(i + 1) % n], rect):
            return True
    return False


def rdp(pts, tol):
    """Iterative Ramer-Douglas-Peucker on an open polyline (endpoints kept)."""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        x0, z0 = pts[i0]
        x1, z1 = pts[i1]
        dx, dz = x1 - x0, z1 - z0
        L2 = dx * dx + dz * dz
        dmax, imax = -1.0, -1
        for i in range(i0 + 1, i1):
            px, pz = pts[i]
            if L2 < 1e-12:
                d2 = (px - x0) ** 2 + (pz - z0) ** 2
            else:
                t = ((px - x0) * dx + (pz - z0) * dz) / L2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                d2 = (px - x0 - t * dx) ** 2 + (pz - z0 - t * dz) ** 2
            if d2 > dmax:
                dmax, imax = d2, i
        if dmax > tol * tol:
            keep[imax] = True
            stack.append((i0, imax))
            stack.append((imax, i1))
    return [pts[i] for i in range(n) if keep[i]]


def rdp_ring(ring, tol):
    """RDP a closed ring: anchor at vertex 0 and the vertex farthest from it."""
    n = len(ring)
    if n < 5:
        return list(ring)
    x0, z0 = ring[0]
    imax, dmax = 1, -1.0
    for i in range(1, n):
        d = (ring[i][0] - x0) ** 2 + (ring[i][1] - z0) ** 2
        if d > dmax:
            dmax, imax = d, i
    a = rdp(ring[:imax + 1], tol)
    b = rdp(ring[imax:] + [ring[0]], tol)
    return a[:-1] + b[:-1]


def tol_for_area(a, f_small, f_all):
    for i, (amax, tol) in enumerate(TOL_TABLE):
        if a < amax:
            return tol * f_all * (f_small if i < SMALL_BUCKETS else 1.0)
    return TOL_TABLE[-1][1] * f_all


def round_ring(ring):
    """Round to int metres, drop consecutive duplicates and the closing dup.
    Returns (int_ring, index_map old->new or None-for-dropped)."""
    n = len(ring)
    out, imap = [], [None] * n
    for i, (x, z) in enumerate(ring):
        p = (int(round(x)), int(round(z)))
        if out and p == out[-1]:
            imap[i] = len(out) - 1
        else:
            out.append(p)
            imap[i] = len(out) - 1
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
        for i in range(n):
            if imap[i] == len(out):
                imap[i] = 0
    return out, imap


# ---------------------------------------------------------------- stitching
def stitch(ways):
    """Join coastline ways end-to-start by shared node id (OSM coastline ways
    are consistently oriented: land LEFT / water RIGHT of travel direction).
    Returns (closed_rings, open_chains, stats); each item is
    {'pts': [(x,z)...], 'way_ids': [...], 'names': {...}} in game floats."""
    ids = sorted(ways.keys())
    by_start = {}
    ends_at = {}
    for wid in ids:
        first, last, pts, name, place = ways[wid]
        if first == last:                    # single-way closed ring
            continue
        by_start.setdefault(first, []).append(wid)
        ends_at[last] = ends_at.get(last, 0) + 1

    used = set()
    closed, opens = [], []

    def emit(way_list, is_closed):
        pts, wids, names = [], [], {}
        for wid in way_list:
            first, last, wpts, name, place = ways[wid]
            seg = wpts if not pts else wpts[1:]   # shared node deduped
            pts.extend(seg)
            wids.append(wid)
            if name:
                names[wid] = (name, place)
        if is_closed and len(pts) > 1 and pts[0] == pts[-1]:
            pts = pts[:-1]
        item = {"pts": pts, "way_ids": wids, "names": names}
        (closed if is_closed else opens).append(item)

    for wid in ids:                          # single-way rings first
        first, last, pts, name, place = ways[wid]
        if first == last and wid not in used:
            used.add(wid)
            item = {"pts": pts[:-1] if pts[0] == pts[-1] else pts,
                    "way_ids": [wid], "names": {wid: (name, place)} if name else {}}
            closed.append(item)

    # open chains: start from ways whose first node is no other way's last
    for wid in ids:
        if wid in used:
            continue
        first = ways[wid][0]
        if ends_at.get(first):
            continue
        chain = []
        cur = wid
        while cur is not None and cur not in used:
            used.add(cur)
            chain.append(cur)
            nxt = None
            for cand in by_start.get(ways[cur][1], []):
                if cand not in used:
                    nxt = cand
                    break
            cur = nxt
        emit(chain, False)

    # what remains are cyclic groups = multi-way closed rings
    for wid in ids:
        if wid in used or ways[wid][0] == ways[wid][1]:
            continue
        chain = [wid]
        used.add(wid)
        cur = wid
        while True:
            nxt = None
            for cand in by_start.get(ways[cur][1], []):
                if cand not in used:
                    nxt = cand
                    break
            if nxt is None:
                break
            used.add(nxt)
            chain.append(nxt)
            cur = nxt
        if ways[chain[-1]][1] == ways[chain[0]][0]:
            emit(chain, True)
        else:
            emit(chain, False)               # broken cycle -> open

    # heal small endpoint gaps (OSM data gaps) by snapping open chains
    healed = 0
    changed = True
    while changed:
        changed = False
        for i in range(len(opens)):
            a = opens[i]
            if a is None:
                continue
            ax, az = a["pts"][-1]
            # self-close?
            sx, sz = a["pts"][0]
            if math.hypot(ax - sx, az - sz) < HEAL_DIST:
                closed.append(a)
                opens[i] = None
                healed += 1
                changed = True
                continue
            best, bd = None, HEAL_DIST
            for j in range(len(opens)):
                if i == j or opens[j] is None:
                    continue
                bx, bz = opens[j]["pts"][0]
                d = math.hypot(ax - bx, az - bz)
                if d < bd:
                    best, bd = j, d
            if best is not None:
                b = opens[best]
                a["pts"] = a["pts"] + b["pts"]
                a["way_ids"] += b["way_ids"]
                a["names"].update(b["names"])
                opens[best] = None
                healed += 1
                changed = True
    opens = [o for o in opens if o is not None]
    return closed, opens, healed


# ------------------------------------------------------- mainland closure
def clip_chain_to_rect(pts, rect):
    """Clip an open polyline to the rect; returns boundary-to-boundary pieces
    plus a count of pieces with interior endpoints (data-gap suspects)."""
    xw, xe, zn, zs = rect

    def inside(p):
        return xw - EPS <= p[0] <= xe + EPS and zn - EPS <= p[1] <= zs + EPS

    def cross(p, q):
        """entry+exit points of segment p->q with the rect (Liang-Barsky)."""
        t0, t1 = 0.0, 1.0
        dx, dz = q[0] - p[0], q[1] - p[1]
        for pk, qk in ((-dx, p[0] - xw), (dx, xe - p[0]),
                       (-dz, p[1] - zn), (dz, zs - p[1])):
            if abs(pk) < EPS:
                if qk < 0:
                    return None
                continue
            t = qk / pk
            if pk < 0:
                if t > t1:
                    return None
                t0 = max(t0, t)
            else:
                if t < t0:
                    return None
                t1 = min(t1, t)
        if t0 > t1:
            return None
        return (t0, (p[0] + t0 * dx, p[1] + t0 * dz)), (t1, (p[0] + t1 * dx, p[1] + t1 * dz))

    pieces, cur = [], []
    interior_ends = 0
    prev = pts[0]
    prev_in = inside(prev)
    if prev_in:
        cur = [prev]
        interior_ends += 1                   # chain STARTS inside the box
    for i in range(1, len(pts)):
        p = pts[i]
        pin = inside(p)
        if prev_in and pin:
            cur.append(p)
        elif prev_in and not pin:
            hit = cross(prev, p)
            if hit:
                cur.append(hit[1][1])
            pieces.append(cur)
            cur = []
        elif not prev_in and pin:
            hit = cross(prev, p)
            cur = [hit[0][1]] if hit else []
            cur.append(p)
        else:                                # both out; may still slice through
            hit = cross(prev, p)
            if hit and hit[0][0] < hit[1][0] - EPS:
                pieces.append([hit[0][1], hit[1][1]])
        prev, prev_in = p, pin
    if cur:
        interior_ends += 1                   # chain ENDS inside the box
        pieces.append(cur)

    good = []
    for pc in pieces:
        if len(pc) < 2:
            continue
        L = sum(math.hypot(pc[i+1][0]-pc[i][0], pc[i+1][1]-pc[i][1])
                for i in range(len(pc)-1))
        if L < 1.0:
            continue
        good.append(pc)
    return good, interior_ends


def boundary_t(p, rect):
    """Perimeter parameter, walking geo-CCW: SW->SE (south edge, z=ZS) ->
    NE (east edge) -> NW (north edge) -> SW (west edge)."""
    xw, xe, zn, zs = rect
    W, H = xe - xw, zs - zn
    x, z = p
    if abs(z - zs) < 0.01:
        return x - xw
    if abs(x - xe) < 0.01:
        return W + (zs - z)
    if abs(z - zn) < 0.01:
        return W + H + (xe - x)
    if abs(x - xw) < 0.01:
        return 2 * W + H + (z - zn)
    raise ValueError(f"point {p} not on rect boundary")


def close_mainland(open_chains, rect):
    """Close open coastline against the bbox: land polygons via the standard
    box walk (water right of way direction => walk the boundary geo-CCW from
    each piece's exit to the next piece's entry, inserting corners)."""
    xw, xe, zn, zs = rect
    W, H = xe - xw, zs - zn
    P = 2 * W + 2 * H
    corners = [(W, (xe, zs)), (W + H, (xe, zn)),
               (2 * W + H, (xw, zn)), (P, (xw, zs))]   # t=P == t=0 (SW)

    pieces = []
    interior_total = 0
    for ch in open_chains:
        pcs, bad = clip_chain_to_rect(ch["pts"], rect)
        interior_total += bad
        if bad:                              # can't trust interior-ended pieces
            pcs = [pc for pc in pcs
                   if _on_boundary(pc[0], rect) and _on_boundary(pc[-1], rect)]
        pieces.extend(pcs)

    if not pieces:
        return [], interior_total

    events = []                              # (t_entry, t_exit, piece_index)
    for idx, pc in enumerate(pieces):
        events.append((boundary_t(pc[0], rect), boundary_t(pc[-1], rect), idx))
    entries = sorted((e[0], i) for i, e in enumerate(events))

    used = [False] * len(pieces)
    polys = []
    for start in range(len(pieces)):
        if used[start]:
            continue
        ring = []
        cur = start
        for _guard in range(len(pieces) + 2):
            used[cur] = True
            ring.extend(pieces[cur])
            t_out = events[cur][1]
            # next entry strictly after t_out (cyclic)
            nxt = None
            for te, idx in entries:
                if te > t_out + 1e-7:
                    nxt = (te, idx)
                    break
            if nxt is None:
                nxt = entries[0]
                te = nxt[0] + P
            else:
                te = nxt[0]
            # corners between t_out and te, in WALK order (cyclic wrap-safe)
            cs = []
            for ct, cp in corners:
                for lap in (0.0, P):
                    t = ct + lap
                    if t_out + 1e-7 < t < te - 1e-7:
                        cs.append((t, cp))
            for _t, cp in sorted(cs):
                ring.append(cp)
            if nxt[1] == start:
                break
            if used[nxt[1]]:
                raise RuntimeError("mainland walk: non-alternating boundary "
                                   "events -- coastline orientation broken")
            cur = nxt[1]
        else:
            raise RuntimeError("mainland walk did not close")
        if len(ring) >= 3:
            polys.append(ring)

    # sanity: land polys must be CW in the game frame (negative shoelace),
    # exactly like island rings
    fixed = []
    for r in polys:
        if shoelace2(r) > 0:
            r = r[::-1]
        fixed.append(r)
    return fixed, interior_total


def _on_boundary(p, rect):
    xw, xe, zn, zs = rect
    x, z = p
    return (abs(x - xw) < 0.01 or abs(x - xe) < 0.01 or
            abs(z - zn) < 0.01 or abs(z - zs) < 0.01)


# ------------------------------------------------------- mainland tiling
def sh_clip(poly, ax, val, keep_ge):
    """Sutherland-Hodgman against one axis-aligned half-plane."""
    out = []
    n = len(poly)
    if n == 0:
        return out
    for i in range(n):
        cur = poly[i]
        prv = poly[i - 1]
        cin = cur[ax] >= val - EPS if keep_ge else cur[ax] <= val + EPS
        pin = prv[ax] >= val - EPS if keep_ge else prv[ax] <= val + EPS
        if cin != pin:
            t = (val - prv[ax]) / (cur[ax] - prv[ax])
            o = prv[1 - ax] + t * (cur[1 - ax] - prv[1 - ax])
            out.append((val, o) if ax == 0 else (o, val))
        if cin:
            out.append(cur)
    return out


def _line_sets(rect):
    """All clip-line coordinates: the 8 km grid plus the bbox boundary."""
    xw, xe, zn, zs = rect
    xs = [k * CELL for k in range(int(math.floor(xw / CELL)),
                                  int(math.ceil(xe / CELL)) + 1)] + [xw, xe]
    zs_ = [k * CELL for k in range(int(math.floor(zn / CELL)),
                                   int(math.ceil(zs / CELL)) + 1)] + [zn, zs]
    return xs, zs_


def _on_line(v, lines, tol):
    return any(abs(v - L) <= tol for L in lines)


def _same_line(v0, v1, lines, tol):
    return any(abs(v0 - L) <= tol and abs(v1 - L) <= tol for L in lines)


def _merge_collinear_cuts(ring, lx, lz, tol):
    """Drop vertices whose prev+self+next all lie on one clip line (S-H spews
    collinear points along cell borders; the seam only needs its endpoints)."""
    changed = True
    while changed and len(ring) > 4:
        changed = False
        out = []
        n = len(ring)
        for i in range(n):
            a, b, c = ring[i - 1], ring[i], ring[(i + 1) % n]
            drop = False
            for lines, ax in ((lx, 0), (lz, 1)):
                for L in lines:
                    if (abs(a[ax] - L) <= tol and abs(b[ax] - L) <= tol
                            and abs(c[ax] - L) <= tol):
                        drop = True
                        break
                if drop:
                    break
            if not drop:
                out.append(b)
            else:
                changed = True
        ring = out
    return ring


def tile_mainland(land_polys, rect, tol):
    """Cut land polygons into 8x8 km cells. Returns records
    {'p': int ring, 'a': int, 'q': [cut edge start indices]} sorted by cell."""
    xw, xe, zn, zs = rect
    lx, lz = _line_sets(rect)
    i0, i1 = int(math.floor(xw / CELL)), int(math.floor((xe - 1e-6) / CELL))
    j0, j1 = int(math.floor(zn / CELL)), int(math.floor((zs - 1e-6) / CELL))

    # pre-simplify NATURAL coast before any clipping: cut edges do not exist
    # yet, so nothing artificial can move, and both sides of every future cell
    # seam share identical simplified geometry
    simp = []
    for poly in land_polys:
        # split at bbox-boundary vertices so closure runs stay exact
        n = len(poly)
        onb = [_on_boundary(p, rect) for p in poly]
        runs, cur = [], [poly[0]]
        for i in range(1, n + 1):
            p = poly[i % n]
            cur.append(p)
            if onb[i % n]:
                runs.append(cur)
                cur = [p]
        if len(cur) > 1:
            runs.append(cur)
        out = []
        for run in runs:
            r = rdp(run, tol) if len(run) > 2 else run
            out.extend(r[:-1])
        simp.append(out if out else poly)

    records = {}
    for pno, poly in enumerate(simp):
        if len(poly) < 3:
            continue
        bx0 = min(p[0] for p in poly); bx1 = max(p[0] for p in poly)
        for i in range(max(i0, int(math.floor(bx0 / CELL))),
                       min(i1, int(math.floor(bx1 / CELL))) + 1):
            strip = sh_clip(poly, 0, i * CELL, True)
            strip = sh_clip(strip, 0, (i + 1) * CELL, False)
            if len(strip) < 3:
                continue
            bz0 = min(p[1] for p in strip); bz1 = max(p[1] for p in strip)
            for j in range(max(j0, int(math.floor(bz0 / CELL))),
                           min(j1, int(math.floor(bz1 / CELL))) + 1):
                cell = sh_clip(strip, 1, j * CELL, True)
                cell = sh_clip(cell, 1, (j + 1) * CELL, False)
                if len(cell) < 3:
                    continue
                area = abs(shoelace2(cell)) / 2.0
                if area < SLIVER:
                    continue
                cell = _merge_collinear_cuts(cell, lx, lz, 1e-4)
                if len(cell) < 3:
                    continue
                # cut mask on floats (S-H points sit exactly on clip lines)
                n = len(cell)
                cut = set()
                for k in range(n):
                    a, b = cell[k], cell[(k + 1) % n]
                    if (_same_line(a[0], b[0], lx, 1e-4)
                            or _same_line(a[1], b[1], lz, 1e-4)):
                        cut.add(k)
                ring, imap = round_ring(cell)
                if len(ring) < 3:
                    continue
                q = set()
                for k in cut:
                    a, b = imap[k], imap[(k + 1) % n]
                    if a is not None and b is not None and a != b:
                        q.add(a)
                if len(ring) == 3:
                    # gate requires >=4 vertices; split the first NATURAL edge
                    nat = [k for k in range(3) if k not in
                           {qq for qq in q}]
                    k = nat[0] if nat else 0
                    a, b = ring[k], ring[(k + 1) % 3]
                    mid = (int(round((a[0] + b[0]) / 2)),
                           int(round((a[1] + b[1]) / 2)))
                    ring = ring[:k + 1] + [mid] + ring[k + 1:]
                    q = {qq if qq <= k else qq + 1 for qq in q}
                rec = {"p": [[x, z] for x, z in ring],
                       "a": int(round(area)),
                       "q": sorted(q),
                       "_pno": pno}          # which input polygon; stripped
                # one record per (cell x land-polygon piece): distinct land
                # polygons meeting in one cell (bay mouths on the bbox edge)
                # each keep their geometry
                records[(j, i, pno)] = rec
    return [records[k] for k in sorted(records.keys())]


# ---------------------------------------------------------------- naming
def build_ring_index(islands):
    """Coarse spatial bucket (4 km) of island indices by ring bbox."""
    B = 4000.0
    buckets = {}
    for idx, isl in enumerate(islands):
        r = isl["ring"]
        bx0 = min(p[0] for p in r); bx1 = max(p[0] for p in r)
        bz0 = min(p[1] for p in r); bz1 = max(p[1] for p in r)
        isl["bbox"] = (bx0, bz0, bx1, bz1)
        for i in range(int(bx0 // B), int(bx1 // B) + 1):
            for j in range(int(bz0 // B), int(bz1 // B) + 1):
                buckets.setdefault((i, j), []).append(idx)
    return buckets


def smallest_ring_containing(x, z, islands, buckets):
    B = 4000.0
    cands = buckets.get((int(x // B), int(z // B)), [])
    best, ba = None, float("inf")
    for idx in cands:
        isl = islands[idx]
        bx0, bz0, bx1, bz1 = isl["bbox"]
        if not (bx0 <= x <= bx1 and bz0 <= z <= bz1):
            continue
        if isl["a"] < ba and pip(x, z, isl["ring"]):
            best, ba = idx, isl["a"]
    return best


def assign_names(islands, name_els, way_to_island):
    """Priorities: 1 relation member-way match > 2 place-tagged member way >
    3 single-closed-way name tag > 4 place node PIP > 5 center PIP."""
    stats = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    buckets = build_ring_index(islands)

    def setname(idx, name, pri):
        if idx is not None and "n" not in islands[idx]:
            islands[idx]["n"] = name
            stats[pri] += 1

    # P1: relations by member ways.  A ring may be claimed by SEVERAL place
    # relations (a causeway-joined islet's relation shares the merged ring
    # with the main island's relation) -- the ring takes the relation with
    # the MOST member ways in it, so Storlandet is not misnamed after the
    # skerry Grangrundet that happens to sort first by relation id.
    rels = sorted((el for el in name_els if el.get("type") == "relation"),
                  key=lambda e: e["id"])
    unmatched_rels = []
    ring_cands = {}
    for el in rels:
        hits = {}
        for m in el.get("members", []):
            if m.get("type") == "way" and m.get("role", "") in ("outer", ""):
                idx = way_to_island.get(m["ref"])
                if idx is not None:
                    hits[idx] = hits.get(idx, 0) + 1
        if hits:
            for idx in sorted(hits):
                ring_cands.setdefault(idx, []).append(
                    (-hits[idx], el["id"], el["tags"]["name"]))
        else:
            unmatched_rels.append(el)
    for idx in sorted(ring_cands):
        setname(idx, sorted(ring_cands[idx])[0][2], 1)

    # P2/P3: tags carried on the coastline ways themselves
    for isl in sorted(islands, key=lambda i: min(i["way_ids"])):
        if "n" in isl:
            continue
        placed = sorted({nm for nm, pl in isl["names"].values()
                         if pl in ("island", "islet")})
        if len(placed) == 1:
            isl["n"] = placed[0]
            stats[2] += 1
        elif len(isl["way_ids"]) == 1 and len(isl["names"]) == 1:
            isl["n"] = next(iter(isl["names"].values()))[0]
            stats[3] += 1

    # P4: place nodes
    for el in sorted((e for e in name_els if e.get("type") == "node"),
                     key=lambda e: e["id"]):
        idx = smallest_ring_containing(*proj(el["lon"], el["lat"]),
                                       islands=islands, buckets=buckets)
        setname(idx, el["tags"]["name"], 4)

    # P5: centers of unmatched relations and of place WAYS not in any ring
    for el in sorted(unmatched_rels, key=lambda e: e["id"]):
        c = el.get("center")
        if c:
            idx = smallest_ring_containing(*proj(c["lon"], c["lat"]),
                                           islands=islands, buckets=buckets)
            setname(idx, el["tags"]["name"], 5)
    for el in sorted((e for e in name_els if e.get("type") == "way"),
                     key=lambda e: e["id"]):
        if el["id"] in way_to_island:
            idx = way_to_island[el["id"]]
            setname(idx, el["tags"]["name"], 2)
            continue
        c = el.get("center")
        if c:
            idx = smallest_ring_containing(*proj(c["lon"], c["lat"]),
                                           islands=islands, buckets=buckets)
            setname(idx, el["tags"]["name"], 5)
    return stats


def name_big_ring(br, name_els):
    """Name a big diverted ring (Fasta Åland) with the same priority ladder
    as assign_names: relation with the MOST member ways on the ring wins
    (tie: lowest relation id), then place-tagged way names, then a lone way
    name tag.  Returns the name or None (reported honestly)."""
    wids = set(br["way_ids"])
    best = None                                # (-hits, rel_id, name)
    for el in sorted((e for e in name_els if e.get("type") == "relation"),
                     key=lambda e: e["id"]):
        hits = sum(1 for m in el.get("members", [])
                   if m.get("type") == "way"
                   and m.get("role", "") in ("outer", "")
                   and m.get("ref") in wids)
        if hits:
            cand = (-hits, el["id"], el["tags"]["name"])
            if best is None or cand < best:
                best = cand
    if best:
        return best[2]
    placed = sorted({nm for nm, pl in br["names"].values()
                     if pl in ("island", "islet")})
    if len(placed) == 1:
        return placed[0]
    allnames = sorted({nm for nm, pl in br["names"].values()})
    if len(allnames) == 1:
        return allnames[0]
    return None


# ---------------------------------------------------------------- pipeline
def build():
    ways = fetch_coastline()
    name_els = fetch_names()
    swedish_ids = fetch_swedish_ways()
    closed, opens, healed = stitch(ways)

    mkx, mkz = proj(MARKET_LL[1], MARKET_LL[0])
    swe_x_max, _ = proj(SWEDEN_FALLBACK_LON, 0)
    _, swe_z_min = proj(0, SWEDEN_FALLBACK_LAT)

    # ---- islands: closed LAND rings intersecting the bbox, FULL ring.
    # Rings above BIG_RING_MIN_M2 (Fasta Åland) divert to mainland-style
    # tiling; Swedish rings are clipped out (Märket exempt, kept whole).
    islands, big_rings = [], []
    lagoons = 0
    sweden_dropped = []
    for ch in closed:
        ring = ch["pts"]
        if len(ring) < 3:
            continue
        s2 = shoelace2(ring)
        if s2 > 0:
            lagoons += 1                     # water-enclosing ring: lake/lagoon
            continue
        if not ring_intersects_rect(ring, RECT):
            continue
        a = abs(s2) / 2.0
        if a < AREA_MIN:
            continue
        cx, cz = area_centroid(ring)
        if math.hypot(cx - mkx, cz - mkz) > MARKET_KEEP_M:
            swedish = (any(w in swedish_ids for w in ch["way_ids"])
                       if swedish_ids else
                       (cx < swe_x_max and cz > swe_z_min))
            if swedish:
                nm = next((n for n, p in ch["names"].values()), None)
                sweden_dropped.append((nm, int(round(a))))
                continue
        rec = {"ring": ring, "a": int(round(a)), "cx": cx, "cz": cz,
               "way_ids": ch["way_ids"], "names": ch["names"]}
        if a > BIG_RING_MIN_M2:
            big_rings.append(rec)
        else:
            islands.append(rec)
    big_rings.sort(key=lambda r: -r["a"])

    # cross-check: NOTHING Finnish lives in the geometric fallback zone, so
    # any surviving ring there means the admin-area filter missed Sweden
    sweden_kept_in_zone = sum(
        1 for isl in islands
        if isl["cx"] < swe_x_max and isl["cz"] > swe_z_min
        and math.hypot(isl["cx"] - mkx, isl["cz"] - mkz) > MARKET_KEEP_M)
    market_kept = any(math.hypot(isl["cx"] - mkx, isl["cz"] - mkz)
                      <= MARKET_KEEP_M for isl in islands)

    # deterministic final order NOW (area desc, like the current file), so the
    # cover remap indices survive the size-tune loop untouched
    islands.sort(key=lambda i: (-i["a"], int(round(i["cx"])), int(round(i["cz"]))))
    way_to_island = {}
    for idx, isl in enumerate(islands):
        for wid in isl["way_ids"]:
            way_to_island[wid] = idx

    name_stats = assign_names(islands, name_els, way_to_island)
    for br in big_rings:
        br["n"] = name_big_ring(br, name_els)
        print(f"big ring: a={br['a']/1e6:.1f} km^2 "
              f"name={br['n']!r} ways={len(br['way_ids'])}", flush=True)

    # ---- preliminary remap (old NON-tile records -> new islands) on
    # full-res centroids; feeds the old-name transfer.  The published remap
    # is rebuilt after serialization over FINAL record positions (+ tiles).
    with open(OLD_MAP) as f:
        old = json.load(f)
    old_isl = old["islands"]
    B = 300.0
    cbuck = {}
    for idx, isl in enumerate(islands):
        cbuck.setdefault((int(isl["cx"] // B), int(isl["cz"] // B)), []).append(idx)
    remap = {}
    dup_targets = 0
    seen_new = set()
    shifts = []
    for oi, orec in enumerate(old_isl):
        if orec.get("k") == MAINLAND_K:
            continue                         # tiles matched later, tile-to-tile
        ocx, ocz = area_centroid(orec["p"])
        oa = orec["a"]
        bi, bj = int(ocx // B), int(ocz // B)
        best, bd = None, 150.0
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for ni in cbuck.get((bi + di, bj + dj), []):
                    isl = islands[ni]
                    if not (0.6 <= isl["a"] / max(oa, 1) <= 1.6):
                        continue
                    d = math.hypot(isl["cx"] - ocx, isl["cz"] - ocz)
                    if d < bd:
                        best, bd = ni, d
        if best is not None:
            remap[oi] = best
            if best in seen_new:
                dup_targets += 1
            seen_new.add(best)
            shifts.append(bd)

    # name transfer for matched-but-unnamed islands (keeps every old name)
    transferred = 0
    for oi, ni in sorted(remap.items()):
        n = old_isl[oi].get("n")
        if n and "n" not in islands[ni]:
            islands[ni]["n"] = n
            transferred += 1

    # ---- kinds (area rule + the two forced-sparse outer-sea islands,
    # anchor-matched so Brändö's larger Jurmo namesake stays untouched)
    forced_pts = {}
    for fname, anchor in FORCED_SPARSE.items():
        cands = [r for r in old_isl
                 if r.get("n") == fname and r.get("k") != MAINLAND_K]
        if cands:
            ref = min(cands, key=lambda r: math.hypot(
                area_centroid(r["p"])[0] - anchor[0],
                area_centroid(r["p"])[1] - anchor[1]))
            forced_pts[fname] = area_centroid(ref["p"])
    for isl in islands:
        a = isl["a"]
        k = "bald" if a < KIND_BALD_MAX else (
            "sparse" if a < KIND_SPARSE_MAX else "forest")
        n = isl.get("n")
        if n in forced_pts:
            fx, fz = forced_pts[n]
            if math.hypot(isl["cx"] - fx, isl["cz"] - fz) < 3000.0:
                k = "sparse"
        isl["k"] = k

    # ---- mainland: drop far-west open fragments first (Swedish fetch-margin
    # coast bits / broken west-strip rings) -- there is no legitimate mainland
    # chain west of the guard, and a stray fragment would otherwise walk the
    # bbox and fabricate land along the new west edge
    guard_x, _ = proj(WEST_CHAIN_GUARD_LON, 0)
    west_frags = [o for o in opens if max(p[0] for p in o["pts"]) < guard_x]
    opens_kept = [o for o in opens if max(p[0] for p in o["pts"]) >= guard_x]
    if west_frags:
        print(f"west-chain guard: dropped {len(west_frags)} open fragments "
              f"entirely W of lon {WEST_CHAIN_GUARD_LON} "
              f"(largest {max(len(o['pts']) for o in west_frags)} pts)",
              flush=True)
    land_polys, interior_ends = close_mainland(opens_kept, RECT)
    n_closure = len(land_polys)
    tile_polys = land_polys + [br["ring"] for br in big_rings]

    # ---- serialize with the size-tune loop
    f_small, f_all, f_main = 1.0, 1.0, 1.0
    for _tune in range(12):
        recs = []
        for isl in islands:
            tol = tol_for_area(isl["a"], f_small, f_all)
            ring = rdp_ring(isl["ring"], tol)
            iring, _ = round_ring(ring)
            if len(iring) < 4:               # match the old file's 4-vertex floor
                n = len(isl["ring"])
                iring, _ = round_ring([isl["ring"][0], isl["ring"][n // 4],
                                       isl["ring"][n // 2], isl["ring"][3 * n // 4]])
            if len(iring) < 3:
                continue
            rec = {"p": [[x, z] for x, z in iring], "k": isl["k"], "a": isl["a"]}
            if "n" in isl:
                rec["n"] = isl["n"]
            rec["_src"] = isl
            recs.append(rec)

        tiles = tile_mainland(tile_polys, RECT, MAINLAND_TOL * f_main)
        tile_recs = [{"p": t["p"], "k": MAINLAND_K, "a": t["a"], "q": t["q"],
                      "_pno": t["_pno"]} for t in tiles]

        # name each big ring on exactly ONE of its tiles: the piece whose
        # bbox contains the landmass area centroid, else the nearest piece
        big_report = []
        for bi, br in enumerate(big_rings):
            pno = n_closure + bi
            cand = [(i, t) for i, t in enumerate(tile_recs)
                    if t["_pno"] == pno]
            named_at = None
            if cand and br.get("n"):
                inside = [(i, t) for i, t in cand
                          if min(p[0] for p in t["p"]) <= br["cx"]
                          <= max(p[0] for p in t["p"])
                          and min(p[1] for p in t["p"]) <= br["cz"]
                          <= max(p[1] for p in t["p"])]
                pool = inside or cand
                named_at, pick = min(pool, key=lambda it: math.hypot(
                    area_centroid(it[1]["p"])[0] - br["cx"],
                    area_centroid(it[1]["p"])[1] - br["cz"]))
                pick["n"] = br["n"]
            big_report.append({"name": br.get("n"), "a": br["a"],
                               "tiles": len(cand), "named_tile": named_at,
                               "centroid": (br["cx"], br["cz"])})

        out_islands = [{k: v for k, v in r.items() if k != "_src"} for r in recs]
        out_tiles = [{k: v for k, v in t.items() if k != "_pno"}
                     for t in tile_recs]
        data = {"center": [LAT0, LON0], "scale": 1.0,
                "islands": out_islands + out_tiles}
        blob = json.dumps(data, separators=(",", ":")).encode()
        if len(blob) <= MAX_MB * 1e6:
            break
        if f_small < 2.5:
            f_small *= 1.3
        else:
            f_all *= 1.2
            f_main *= 1.2
        print(f"  json {len(blob)/1e6:.2f} MB > {MAX_MB} MB -> "
              f"tolerances x(f_small={f_small:.2f}, f_all={f_all:.2f})", flush=True)

    # ---- FINAL remap: old SHIPPING record index -> final new record index.
    # Islands ride the preliminary match through recs positions; old mainland
    # tiles match new tiles by centroid+area (tile-to-tile only).
    final_index = {}
    for pos, r in enumerate(recs):
        final_index[id(r["_src"])] = pos
    remap_final = {}
    for oi, ni in sorted(remap.items()):
        pos = final_index.get(id(islands[ni]))
        if pos is not None:
            remap_final[str(oi)] = pos
    islands_matched = len(remap_final)

    tbuck = {}
    tile_cents = []
    for pos, t in enumerate(out_tiles):
        c = area_centroid(t["p"])
        tile_cents.append(c)
        tbuck.setdefault((int(c[0] // B), int(c[1] // B)), []).append(pos)
    tiles_matched = 0
    for oi, orec in enumerate(old_isl):
        if orec.get("k") != MAINLAND_K:
            continue
        ocx, ocz = area_centroid(orec["p"])
        oa = orec["a"]
        bi, bj = int(ocx // B), int(ocz // B)
        best, bd = None, 150.0
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for pos in tbuck.get((bi + di, bj + dj), []):
                    if not (0.6 <= out_tiles[pos]["a"] / max(oa, 1) <= 1.6):
                        continue
                    d = math.hypot(tile_cents[pos][0] - ocx,
                                   tile_cents[pos][1] - ocz)
                    if d < bd:
                        best, bd = pos, d
        if best is not None:
            remap_final[str(oi)] = len(out_islands) + best
            tiles_matched += 1
            shifts.append(bd)

    # hand-carry: benchmark islands that failed the automatic match are
    # carried by name + nearest centroid so the cover re-key never loses them
    hand_carried = []
    new_named = {}
    for pos, r in enumerate(out_islands):
        if "n" in r:
            new_named.setdefault(r["n"], []).append(pos)
    for nm, anchor in BENCHMARKS.items():
        olds = [(oi, r) for oi, r in enumerate(old_isl)
                if r.get("n") == nm and r.get("k") != MAINLAND_K]
        if not olds:
            continue
        oi, oref = min(olds, key=lambda t: math.hypot(
            area_centroid(t[1]["p"])[0] - anchor[0],
            area_centroid(t[1]["p"])[1] - anchor[1]))
        if str(oi) in remap_final:
            continue
        ocx, ocz = area_centroid(oref["p"])
        cands = new_named.get(nm, [])
        if cands:
            pos = min(cands, key=lambda p_: math.hypot(
                area_centroid(out_islands[p_]["p"])[0] - ocx,
                area_centroid(out_islands[p_]["p"])[1] - ocz))
            remap_final[str(oi)] = pos
            hand_carried.append((nm, oi, pos))

    remap_blob = json.dumps(remap_final, separators=(",", ":")).encode()

    # ---- geometric-identity audit vs the shipping file (the whole point of
    # cache reuse: matched old-area records should be bit-identical in p)
    all_new = out_islands + out_tiles
    ident = {"matched": 0, "p_identical": 0, "p_drifted": 0,
             "max_shift": 0.0, "n_changed": 0}
    for oi_s, npos in remap_final.items():
        orec = old_isl[int(oi_s)]
        nrec = all_new[npos]
        ident["matched"] += 1
        if orec["p"] == nrec["p"]:
            ident["p_identical"] += 1
        else:
            ident["p_drifted"] += 1
            oc = area_centroid(orec["p"])
            nc = area_centroid(nrec["p"])
            ident["max_shift"] = max(ident["max_shift"],
                                     math.hypot(oc[0] - nc[0], oc[1] - nc[1]))
        if orec.get("n") != nrec.get("n"):
            ident["n_changed"] += 1

    xw_legacy, _ = proj(LEGACY_BBOX[1], 0)
    aland_strip = sum(1 for r in recs if r["_src"]["cx"] < xw_legacy)
    west_closure_tiles = sum(
        1 for t in tile_recs if t["_pno"] < n_closure
        and min(p[0] for p in t["p"]) < guard_x)

    info = {
        "islands": len(out_islands), "tiles": len(out_tiles),
        "closure_tiles": sum(1 for t in tile_recs if t["_pno"] < n_closure),
        "land_polys": n_closure, "big": big_report,
        "lagoons": lagoons, "healed": healed, "interior_ends": interior_ends,
        "west_frags": len(west_frags), "west_closure_tiles": west_closure_tiles,
        "name_stats": name_stats, "transferred_names": transferred,
        "remap": len(remap_final), "old_count": len(old_isl),
        "remap_rate": len(remap_final) / max(len(old_isl), 1),
        "islands_matched": islands_matched, "tiles_matched": tiles_matched,
        "hand_carried": hand_carried, "dup_targets": dup_targets,
        "shift_median": sorted(shifts)[len(shifts) // 2] if shifts else None,
        "ident": ident, "aland_strip": aland_strip,
        "sweden_dropped": sweden_dropped,
        "sweden_mechanism": ("osm-admin-area" if swedish_ids
                             else "geometric-fallback"),
        "sweden_kept_in_zone": sweden_kept_in_zone,
        "market_kept": market_kept,
        "f_small": f_small, "f_all": f_all, "f_main": f_main,
        "mb": len(blob) / 1e6,
        "named": sum(1 for r in out_islands if "n" in r),
        "old_isl": old_isl,
    }
    return blob, remap_blob, info


# ---------------------------------------------------------------- gates
def run_gates(blob, remap_blob, info, sha_ok):
    data = json.loads(blob)
    isl = [r for r in data["islands"] if r.get("k") != MAINLAND_K]
    tiles = [r for r in data["islands"] if r.get("k") == MAINLAND_K]
    old_isl = info["old_isl"]
    results = []

    def gate(name, ok, detail):
        results.append((name, ok, detail))

    # G1 old-area continuity: benchmark names, anchor-disambiguated, new
    # centroid within 50 m of the SHIPPING record (cache-identical expected)
    g1_ok, g1_det = True, []
    for nm, anchor in BENCHMARKS.items():
        olds = [r for r in old_isl
                if r.get("n") == nm and r.get("k") != MAINLAND_K]
        news = [r for r in isl if r.get("n") == nm]
        if not olds or not news:
            g1_ok = False
            g1_det.append(f"{nm}:MISSING({'old' if not olds else 'new'})")
            continue
        oref = min(olds, key=lambda r: math.hypot(
            area_centroid(r["p"])[0] - anchor[0],
            area_centroid(r["p"])[1] - anchor[1]))
        ocx, ocz = area_centroid(oref["p"])
        d = min(math.hypot(area_centroid(r["p"])[0] - ocx,
                           area_centroid(r["p"])[1] - ocz) for r in news)
        if d > 50.0:
            g1_ok = False
        g1_det.append(f"{nm}:{d:.1f}m")
    gate("G1 old-area continuity (<=50 m vs shipping)", g1_ok, " ".join(g1_det))

    # G2 Åland: >=8 of the 11 roster names present WEST of lon 21.2 (so a
    # far-east namesake cannot fake a hit), Fasta Åland tiled with exactly
    # one named tile per big ring, and q valid on every tile
    x_al, _ = proj(21.2, 0)
    west_names = set()
    for r in isl:
        if "n" in r:
            cx, _cz = area_centroid(r["p"])
            if cx < x_al:
                west_names.add(r["n"])
    hits = [(nm, nm in west_names) for nm in ALAND_NAMES]
    n_hit = sum(1 for _, ok in hits if ok)
    q_ok = True
    for t in tiles:
        n = len(t["p"])
        q = t.get("q")
        if (not isinstance(q, list) or not q or n < 4
                or q != sorted(q) or len(set(q)) != len(q)
                or q[0] < 0 or q[-1] >= n):
            q_ok = False
            break
    named_tiles = sum(1 for t in tiles if "n" in t)
    big = info["big"]
    big_ok = (len(big) == 1 and all(b["name"] for b in big)
              and all(b["tiles"] >= 10 for b in big)
              and all(b["named_tile"] is not None for b in big)
              and named_tiles == len(big))
    gate(f"G2 Åland ({n_hit}/11 names, need >=8; big rings + q)",
         n_hit >= 8 and big_ok and q_ok,
         " ".join(("OK:" if ok else "miss:") + nm for nm, ok in hits)
         + f" | big={[(b['name'], b['tiles']) for b in big]}"
         f" named_tiles={named_tiles} q_ok={q_ok}")

    # G3 counts, remap rate, size, bounds, Sweden
    mx0, _ = proj(BBOX[1] - 0.35, 0)
    mx1, _ = proj(BBOX[3] + 0.35, 0)
    _, mz0 = proj(0, BBOX[2] + 0.35)
    _, mz1 = proj(0, BBOX[0] - 0.35)
    ob = 0
    for r in data["islands"]:
        for x, z in r["p"]:
            if not (mx0 <= x <= mx1 and mz0 <= z <= mz1):
                ob += 1
    sweden_ok = (info["sweden_kept_in_zone"] == 0
                 and info["west_closure_tiles"] == 0
                 and info["market_kept"])
    gate("G3 counts 30k-75k, remap>=97%, <=13MB, bounds, no Sweden",
         30_000 <= len(isl) <= 75_000
         and info["remap_rate"] >= 0.97
         and len(blob) <= HARD_MAX_MB * 1e6
         and ob == 0 and sweden_ok,
         f"islands={len(isl)} remap={info['remap_rate']*100:.2f}% "
         f"{len(blob)/1e6:.2f}MB oob={ob} "
         f"swe(kept_in_zone={info['sweden_kept_in_zone']} "
         f"west_closure_tiles={info['west_closure_tiles']} "
         f"märket_kept={info['market_kept']})")

    # G4 idempotency
    gate("G4 idempotent re-run (sha256)", sha_ok,
         "identical" if sha_ok else "DIFFERS")

    print("\n---- SANITY GATES ----")
    allok = True
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  [{detail}]")
        allok = allok and ok
    return allok


def main():
    t0 = time.time()
    print("build pass 1 (fills the cache on first run)...", flush=True)
    blob1, remap1, info = build()
    print(f"pass 1 done in {time.time()-t0:.0f}s -- {info['islands']} islands, "
          f"{info['tiles']} mainland tiles, {info['mb']:.2f} MB", flush=True)

    t1 = time.time()
    print("build pass 2 (pure cache -- proves idempotency)...", flush=True)
    blob2, remap2, _ = build()
    sha1, sha2 = hashlib.sha256(blob1).hexdigest(), hashlib.sha256(blob2).hexdigest()
    rsha1, rsha2 = hashlib.sha256(remap1).hexdigest(), hashlib.sha256(remap2).hexdigest()
    sha_ok = sha1 == sha2 and rsha1 == rsha2
    print(f"pass 2 done in {time.time()-t1:.0f}s; map sha256 {sha1[:16]}... "
          f"{'==' if sha_ok else '!='} {sha2[:16]}...", flush=True)

    with open(OUT_MAP, "wb") as f:
        f.write(blob1)
    with open(OUT_REMAP, "wb") as f:
        f.write(remap1)

    tols = ", ".join(f"a<{amax:g}:{tol*info['f_all']*(info['f_small'] if i < SMALL_BUCKETS else 1):.1f}m"
                     for i, (amax, tol) in enumerate(TOL_TABLE))
    ident = info["ident"]
    print(f"\n---- REPORT ----")
    print(f"outputs: {OUT_MAP} ({info['mb']:.2f} MB), {OUT_REMAP}")
    print(f"islands: {info['islands']} ({info['named']} named; "
          f"{info['aland_strip']} in the new Åland strip W of lon "
          f"{LEGACY_BBOX[1]})  tiles: {info['tiles']} (k={MAINLAND_K!r}: "
          f"{info['closure_tiles']} mainland-closure from "
          f"{info['land_polys']} land polygons + big-ring tiles)")
    for b in info["big"]:
        print(f"big ring: {b['name']!r} a={b['a']/1e6:.1f} km^2 -> "
              f"{b['tiles']} tiles, name on tile #{b['named_tile']} "
              f"(record {info['islands'] + (b['named_tile'] or 0)}), "
              f"centroid ({b['centroid'][0]:.0f},{b['centroid'][1]:.0f})")
    print(f"q encoding: sorted vertex indices i where edge i->(i+1)%n lies on a "
          f"clip line (8 km grid or bbox edge)")
    print(f"RDP tolerances: {tols}; mainland natural edges "
          f"{MAINLAND_TOL*info['f_main']:.1f} m; cut edges never moved")
    print(f"names: relation={info['name_stats'][1]} way-place={info['name_stats'][2]} "
          f"way-tag={info['name_stats'][3]} node={info['name_stats'][4]} "
          f"center={info['name_stats'][5]} old-transfer={info['transferred_names']}")
    print(f"cover remap: {info['remap']}/{info['old_count']} "
          f"({info['remap_rate']*100:.2f}%: {info['islands_matched']} islands "
          f"+ {info['tiles_matched']} tiles), hand-carried "
          f"{info['hand_carried'] or 'none'}, dup targets {info['dup_targets']}, "
          f"median centroid shift {info['shift_median'] and round(info['shift_median'],1)} m")
    print(f"old-area identity: {ident['p_identical']}/{ident['matched']} matched "
          f"records bit-identical in p; {ident['p_drifted']} drifted "
          f"(max centroid shift {ident['max_shift']:.1f} m); "
          f"{ident['n_changed']} name changes")
    print(f"sweden [{info['sweden_mechanism']}]: dropped "
          f"{len(info['sweden_dropped'])} Swedish rings "
          f"{sorted({nm for nm, _ in info['sweden_dropped'] if nm}) or ''}; "
          f"kept-in-zone={info['sweden_kept_in_zone']}; "
          f"Märket kept={info['market_kept']}")
    print(f"overpass: {_net['queries']} live queries, {_net['cache_hits']} cache hits, "
          f"{_net['retries']} retries, {_net['endpoint_switches']} mirror switches")
    print(f"caveats: {info['lagoons']} water-enclosing rings (lakes/lagoons) discarded; "
          f"{info['healed']} endpoint gaps healed; "
          f"{info['interior_ends']} chain ends inside bbox (dropped pieces); "
          f"{info['west_frags']} far-west open fragments dropped pre-closure; "
          f"Kimitoön sits {(BIG_RING_MIN_M2 - 547952121)/1e6:.1f} km^2 below the "
          f"big-ring line (tight but cache-pinned); "
          f"S-H cell clips join multi-part land with zero-width bridges on cell "
          f"borders (marked in q)")

    ok = run_gates(blob1, remap1, info, sha_ok)
    print(f"\ntotal {time.time()-t0:.0f}s -- {'ALL GATES PASSED' if ok else 'GATE FAILURE'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

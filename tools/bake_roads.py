#!/usr/bin/env python3
"""Bake OSM road network for the archipelago sailing game.

Queries Overpass for highways in the game bbox, projects to world metres,
simplifies with RDP, and writes public/archipelago_roads.json:
  {"meta":"OSM highways, c1 major c0 minor","roads":[{"c":0|1,"p":[[x,z],...]},...]}

c=1 major (primary/secondary/tertiary), c=0 minor (unclassified/residential/service/track).

Usage: python3 tools/bake_roads.py [--tol 3.0] [--no-track]
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JSON = os.path.join(ROOT, "public", "archipelago_roads.json")
CACHE = ("/private/tmp/claude-501/-Users-alvinjobb-Projects-github-portfolio/"
         "88c16174-e79a-426d-a54a-ecf150c78848/scratchpad/overpass_roads")

OVERPASS = "https://overpass-api.de/api/interpreter"
UA = "archipelago-sunset-bake/1.0 (personal sailing-game project)"

# bbox: (south, west, north, east)
BBOX = (59.70, 21.15, 60.20, 22.35)
PAD = 0.02  # degrees of slack kept beyond bbox before clipping ways

LON0, LAT0 = 21.49, 59.805
KX = 111320 * math.cos(math.radians(59.805))  # ~55987.8
KZ = 111320.0

MAJOR = {"primary", "secondary", "tertiary"}
MINOR = {"unclassified", "residential", "service", "track"}
HW_RE = "^(primary|secondary|tertiary|unclassified|residential|service|track)$"

os.makedirs(CACHE, exist_ok=True)


def project(lon, lat):
    return (lon - LON0) * KX, -(lat - LAT0) * KZ


def fetch(bbox, tag):
    """Fetch ways in bbox from Overpass, with disk cache and retry/cooldown."""
    cache_path = os.path.join(CACHE, f"{tag}.json")
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return json.load(f)
    s, w, n, e = bbox
    query = (f'[out:json][timeout:180];'
             f'way["highway"~"{HW_RE}"]({s},{w},{n},{e});'
             f'out geom;')
    data = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(OVERPASS, data=data,
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=240) as r:
                payload = json.load(r)
            with open(cache_path, "w") as f:
                json.dump(payload, f)
            return payload
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError,
                json.JSONDecodeError, OSError) as ex:
            last_err = ex
            code = getattr(ex, "code", None)
            cool = 15.0 * (attempt + 1)
            print(f"  [{tag}] attempt {attempt + 1} failed "
                  f"({code or type(ex).__name__}); cooling {cool:.0f}s", flush=True)
            if attempt < 4:
                time.sleep(cool)
    raise last_err


def fetch_all():
    """Whole bbox first; on repeated failure fall back to 4 quadrants."""
    try:
        return fetch(BBOX, "full")["elements"]
    except Exception as ex:
        print(f"whole-bbox query failed ({ex}); falling back to quadrants", flush=True)
    s, w, n, e = BBOX
    ms, mw = (s + n) / 2, (w + e) / 2
    quads = [(s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)]
    elements, seen = [], set()
    for i, q in enumerate(quads):
        els = fetch(q, f"quad{i}")["elements"]
        for el in els:
            if el["id"] not in seen:
                seen.add(el["id"])
                elements.append(el)
        time.sleep(10)  # cooldown between quadrant hits
    return elements


def rdp(pts, tol):
    """Iterative Ramer-Douglas-Peucker on [(x,z),...]."""
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


def polyline_len(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
               for i in range(len(pts) - 1))


def clip_runs(geom):
    """Split way geometry into runs of points inside the padded bbox."""
    s, w, n, e = BBOX
    runs, cur = [], []
    for g in geom:
        lat, lon = g["lat"], g["lon"]
        if (s - PAD) <= lat <= (n + PAD) and (w - PAD) <= lon <= (e + PAD):
            cur.append(project(lon, lat))
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def main():
    tol = 3.0
    drop_track = "--no-track" in sys.argv
    if "--tol" in sys.argv:
        tol = float(sys.argv[sys.argv.index("--tol") + 1])

    elements = fetch_all()
    print(f"fetched {len(elements)} ways from Overpass", flush=True)

    roads = []
    n_major = n_minor = n_pts = 0
    n_short = n_nogeom = 0
    by_hw = {}
    seen = set()
    for el in elements:
        if el.get("type") != "way" or el["id"] in seen:
            continue
        seen.add(el["id"])
        hw = el.get("tags", {}).get("highway", "")
        if hw not in MAJOR and hw not in MINOR:
            continue
        if drop_track and hw == "track":
            continue
        geom = el.get("geometry")
        if not geom:
            n_nogeom += 1
            continue
        c = 1 if hw in MAJOR else 0
        for run in clip_runs(geom):
            pts = rdp(run, tol)
            if len(pts) < 2 or polyline_len(pts) < 30.0:
                n_short += 1
                continue
            ipts = []
            for x, z in pts:
                ip = [round(x), round(z)]
                if not ipts or ip != ipts[-1]:
                    ipts.append(ip)
            if len(ipts) < 2:
                n_short += 1
                continue
            roads.append({"c": c, "p": ipts})
            n_pts += len(ipts)
            by_hw[hw] = by_hw.get(hw, 0) + 1
            if c == 1:
                n_major += 1
            else:
                n_minor += 1

    out = {"meta": "OSM highways, c1 major c0 minor", "roads": roads}
    with open(OUT_JSON, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size = os.path.getsize(OUT_JSON)

    print(f"roads={len(roads)} major(c1)={n_major} minor(c0)={n_minor} "
          f"points={n_pts} dropped_short={n_short} no_geom={n_nogeom}")
    print("by highway:", {k: by_hw[k] for k in sorted(by_hw)})
    print(f"size={size / 1e6:.3f} MB -> {OUT_JSON}")

    # sanity: Nagu/Korpo box and Utö
    def any_in(box):
        x0, x1, z0, z1 = box
        cnt = 0
        for r in roads:
            if any(x0 <= p[0] <= x1 and z0 <= p[1] <= z1 for p in r["p"]):
                cnt += 1
        return cnt

    nagu_korpo = any_in((-12000, 18000, -45000, -32000))
    uto = 0
    ux, uz = -6750, 2600
    for r in roads:
        if any(math.hypot(p[0] - ux, p[1] - uz) < 1500 for p in r["p"]):
            uto += 1
    print(f"sanity: Nagu/Korpo box roads={nagu_korpo}  Uto (<1.5km) roads={uto}")
    if nagu_korpo == 0 or uto == 0:
        print("SANITY FAIL", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

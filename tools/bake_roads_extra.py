#!/usr/bin/env python3
"""Extend public/archipelago_roads.json with (a) Åland highways (the road bake
never reached west of lon 21) and (b) REAL OSM bridges across the whole world,
so bridges render only where they actually exist (no more heuristic false
positives like the phantom bridge over Utö harbour).

Output adds a "bridges" array [{c,p:[[x,z]...]},...] and appends Åland roads.
Idempotent: strips any prior Åland roads (x < -40000) + rewrites bridges."""
import json, math, os, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "archipelago_roads.json")
CACHE = ("/private/tmp/claude-501/-Users-alvinjobb-Projects-github-portfolio/"
         "88c16174-e79a-426d-a54a-ecf150c78848/scratchpad/overpass_roads")
OVERPASS = "https://overpass-api.de/api/interpreter"
MIRROR = "https://overpass.kumi.systems/api/interpreter"
UA = "archipelago-sunset-bake/1.0 (personal sailing-game project)"
LON0, LAT0 = 21.49, 59.805
KX = 111320 * math.cos(math.radians(59.805))
KZ = 111320.0
MAJOR = {"primary", "secondary", "tertiary", "trunk"}
HW_RE = "^(primary|secondary|tertiary|trunk|unclassified|residential|service|track)$"
os.makedirs(CACHE, exist_ok=True)

def project(lon, lat):
    return [round((lon - LON0) * KX, 1), round(-(lat - LAT0) * KZ, 1)]

def fetch(query, tag):
    cp = os.path.join(CACHE, f"{tag}.json")
    if os.path.exists(cp):
        return json.load(open(cp))
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(6):
        url = OVERPASS if attempt % 2 == 0 else MIRROR
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                payload = json.load(r)
            json.dump(payload, open(cp, "w"))
            return payload
        except Exception as ex:
            last = ex
            print(f"  {tag} attempt {attempt+1} failed ({ex}); cooldown", flush=True)
            time.sleep(8 + attempt * 6)
    raise SystemExit(f"FATAL: Overpass unreachable for {tag}: {last}")

def rdp(pts, tol=3.0):
    if len(pts) < 3:
        return pts
    ax, az = pts[0]; bx, bz = pts[-1]
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz or 1e-9
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        px, pz = pts[i]
        t = max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L2))
        d = (px - (ax + t * dx)) ** 2 + (pz - (az + t * dz)) ** 2
        if d > dmax:
            dmax, idx = d, i
    if dmax > tol * tol:
        return rdp(pts[:idx + 1])[:-1] + rdp(pts[idx:])
    return [pts[0], pts[-1]]

def ways_to_lines(elements):
    out = []
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        hw = el.get("tags", {}).get("highway", "")
        c = 1 if hw in MAJOR else 0
        pts = [project(g["lon"], g["lat"]) for g in el["geometry"]]
        if len(pts) < 2:
            continue
        s = rdp(pts)
        if len(s) >= 2:
            out.append({"c": c, "p": s})
    return out

# ---- Åland highways (west strip the road bake missed) --------------------
aland_q = ('[out:json][timeout:240];'
           'way["highway"~"' + HW_RE + '"](59.60,19.05,60.55,21.02);out geom;')
aland = ways_to_lines(fetch(aland_q, "aland_highways")["elements"])
print(f"Åland roads: {len(aland)}", flush=True)

# ---- real bridges across the whole world ---------------------------------
# chunk the wide bbox into 4 lon bands so Overpass stays happy
bridges = []
for i, (w, e) in enumerate([(19.05, 21.0), (21.0, 22.7), (22.7, 24.4), (24.4, 25.95)]):
    q = ('[out:json][timeout:240];'
         f'way["highway"]["bridge"](59.60,{w},60.55,{e});out geom;')
    els = fetch(q, f"bridges_{i}")["elements"]
    bridges += ways_to_lines(els)
    print(f"bridges band {i} ({w}-{e}): +{len(els)} ways", flush=True)
# a bridge way is short; drop degenerate ones
bridges = [b for b in bridges if len(b["p"]) >= 2]
print(f"bridges total: {len(bridges)}", flush=True)

# ---- merge into roads.json ------------------------------------------------
d = json.load(open(OUT))
roads = [r for r in d["roads"] if min(p[0] for p in r["p"]) >= -40000]  # strip old Åland
roads += aland
d["roads"] = roads
d["bridges"] = bridges
d["meta"] = "OSM highways (c1 major c0 minor) + real bridges; whole world incl. Åland"
json.dump(d, open(OUT, "w"), separators=(",", ":"))
mb = os.path.getsize(OUT) / 1e6
print(f"wrote {OUT}: {len(roads)} roads + {len(bridges)} bridges, {mb:.2f} MB", flush=True)

# sanity
aland_now = sum(1 for r in roads if min(p[0] for p in r["p"]) < -40000)
print(f"gate: Åland roads present = {aland_now} (want >0)")
print(f"gate: bridges present = {len(bridges)} (want >20)")
assert aland_now > 0 and len(bridges) > 20, "FAIL"
print("OK")

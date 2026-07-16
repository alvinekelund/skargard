#!/usr/bin/env python3
"""Bake detailed OSM city building polygons for the runtime city renderer.

NLS remains the nationwide source of truth for building presence. This layer is
the richer city override: actual polygon outlines plus levels/use/roof/material
tags where OSM has them. It deliberately targets the five rendered city cores,
is cached, chunked to keep Overpass reliable, and writes a compact array schema:

  [height_dm, kind, roof, material, [[x,z], ...]]

kind: 0 residential/mixed, 1 commercial, 2 industrial, 3 civic, 4 religious
roof: 0 unknown, 1 flat, 2 gabled, 3 hipped, 4 mansard, 5 pyramidal/dome
material: 0 unknown, 1 brick, 2 plaster/concrete, 3 wood, 4 glass/metal
"""
import argparse, json, math, os, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "city_buildings.json")
OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]
UA = "skargard-city-bake/1.0 (personal sailing-game project)"
LAT0, LON0 = 59.805, 21.49
KX = 111320.0 * math.cos(math.radians(LAT0)); KZ = 111320.0

# Tight enough to avoid suburban data bloat, broad enough to cover every view
# from the city waterfront. (south, west, north, east)
CITIES = {
    "helsinki": (60.145, 24.900, 60.185, 25.010),
    "turku": (60.425, 22.215, 60.475, 22.330),
    "porvoo": (60.375, 25.615, 60.420, 25.705),
    "hanko": (59.805, 22.925, 59.845, 23.015),
    "mariehamn": (60.080, 19.900, 60.120, 19.980),
}

def project(lon, lat):
    return [(lon - LON0) * KX, -(lat - LAT0) * KZ]

def rdp(points, eps=0.45):
    if len(points) <= 3: return points
    ax, az = points[0]; bx, bz = points[-1]
    dx, dz = bx - ax, bz - az; den = dx * dx + dz * dz
    best_i = 0; best = -1
    for i, (x, z) in enumerate(points[1:-1], 1):
        if den:
            t = max(0, min(1, ((x-ax)*dx + (z-az)*dz) / den))
            d = math.hypot(x - (ax+t*dx), z - (az+t*dz))
        else: d = math.hypot(x-ax, z-az)
        if d > best: best, best_i = d, i
    if best <= eps: return [points[0], points[-1]]
    return rdp(points[:best_i+1], eps)[:-1] + rdp(points[best_i:], eps)

def classify(tags):
    b = tags.get("building", "").lower()
    if b in {"church", "chapel", "cathedral", "religious"}: kind = 4
    elif b in {"civic", "public", "school", "hospital", "university", "government"}: kind = 3
    elif b in {"industrial", "warehouse", "factory", "hangar"}: kind = 2
    elif b in {"commercial", "retail", "office", "hotel"}: kind = 1
    else: kind = 0
    rs = tags.get("roof:shape", "").lower()
    roof = 1 if rs == "flat" else 2 if rs in {"gabled", "gambrel", "saltbox"} else \
           3 if rs in {"hipped", "half-hipped"} else 4 if rs == "mansard" else \
           5 if rs in {"pyramidal", "dome", "onion"} else 0
    mat = (tags.get("building:material") or tags.get("facade:material") or "").lower()
    material = 1 if "brick" in mat else 2 if mat in {"plaster", "stucco", "concrete", "stone"} else \
               3 if mat in {"wood", "timber"} else 4 if mat in {"glass", "metal", "steel"} else 0
    try: levels = float(tags.get("building:levels", "0").split(";")[0])
    except ValueError: levels = 0
    try: height = float(tags.get("height", "0").replace(" m", ""))
    except ValueError: height = 0
    if not height and levels: height = levels * 3.15
    return min(800, max(0, round(height * 10))), kind, roof, material

def fetch(cache, city, bbox, step=0.20):
    s, w, n, e = bbox; out = []
    rows = math.ceil((n-s)/step); cols = math.ceil((e-w)/step)
    for iy in range(rows):
        for ix in range(cols):
            bb = (s+iy*step, w+ix*step, min(n,s+(iy+1)*step), min(e,w+(ix+1)*step))
            cp = os.path.join(cache, f"{city}_{iy}_{ix}.json")
            if os.path.exists(cp): data = json.load(open(cp))
            else:
                q = f'[out:json][timeout:180];way["building"]({bb[0]},{bb[1]},{bb[2]},{bb[3]});out tags geom;'
                body = urllib.parse.urlencode({"data": q}).encode(); last = None
                for attempt in range(6):
                    try:
                        req = urllib.request.Request(OVERPASS[attempt % len(OVERPASS)], data=body,
                                                     headers={"User-Agent": UA})
                        with urllib.request.urlopen(req, timeout=240) as r: data = json.load(r)
                        json.dump(data, open(cp, "w")); break
                    except Exception as ex:
                        last = ex; time.sleep(5 + attempt * 5)
                else: raise RuntimeError(f"Overpass failed for {city} {bb}: {last}")
            out.extend(data.get("elements", []))
            print(f"{city} chunk {iy+1}/{rows},{ix+1}/{cols}: {len(data.get('elements',[]))}", flush=True)
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--cache", required=True)
    ap.add_argument("--cities", nargs="*", choices=CITIES, default=list(CITIES))
    args = ap.parse_args(); os.makedirs(args.cache, exist_ok=True)
    seen = set(); records = []
    for city in args.cities:
        for el in fetch(args.cache, city, CITIES[city]):
            if el.get("id") in seen: continue
            seen.add(el.get("id")); geom = el.get("geometry") or []
            if len(geom) < 4: continue
            pts = [project(g["lon"], g["lat"]) for g in geom]
            if math.hypot(pts[0][0]-pts[-1][0], pts[0][1]-pts[-1][1]) < 1.0: pts.pop()
            if len(pts) < 3: continue
            pts = rdp(pts + [pts[0]])[:-1]
            if len(pts) < 3: continue
            packed = [[round(x,1), round(z,1)] for x,z in pts]
            records.append([*classify(el.get("tags", {})), packed])
    out = {"meta":"OSM city building polygons + levels/use/roof/material; © OpenStreetMap contributors, ODbL",
           "schema":"[height_dm,kind,roof,material,polygon]", "buildings":records}
    json.dump(out, open(OUT,"w"), separators=(",",":"))
    print(f"wrote {OUT}: {len(records)} buildings, {os.path.getsize(OUT)/1e6:.2f} MB")

if __name__ == "__main__": main()

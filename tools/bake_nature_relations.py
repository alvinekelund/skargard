#!/usr/bin/env python3
"""Supplemental nature bake: multipolygon RELATIONS the way-only bakes dropped.

Both the original nature bake and the expansion bake fetched way[natural=...]
ONLY ("ways only — the old bake ignored relations, so does this one").
Jurmo's famous moraine heath is mapped as natural=heath multipolygon
RELATIONS, so the baked data left the island 1% heath-covered — and the
runtime's authoritative mapped-heath veto (trees never stand on surveyed
heath) had nothing to hold on to.

This script fetches relation["natural"~wood|heath|scrub] + landuse=forest
relations for every COAST tile of the world box, stitches each relation's
"outer" member ways into closed rings, and appends qualifying rings to the
nature array of public/archipelago_data.json with the exact same record
shape, projection, simplification and coastal filter as the way bake. Every
pre-existing byte of the JSON stays identical (splice append, same as
bake_osm_props.py).

Ring rules: each OUTER ring becomes its own record (an archipelago heath
relation is many islands' sweeps); inner rings (holes/clearings) are ignored
— the runtime point test has no hole support and a heath clearing reading as
heath is the conservative error. Records dedupe against existing same-class
polys by centroid+area, and across tiles by relation id.

Usage:
  python3 tools/bake_nature_relations.py --cache <dir outside repo> \
      [--data public/archipelago_data.json] [--map public/archipelago_map.json] \
      [--max-mb 8.9] [--dry-run]
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_osm_props import (  # noqa: E402
    proj, rdp, dedupe, shoelace2, build_coast, any_near,
    tiles_for, tile_has_coast, array_span, append_into,
    overpass, NATURE_MIN_AREA,
)

# full world incl. the Åland extension (buildings went west in a later bake;
# nature relations should cover the same sea the player can reach)
BOX = (59.60, 19.05, 60.55, 25.95)

RDP_TOL = 6.0
MAX_PTS = 40
COAST_R = 1200.0
NAT_CLS = [("natural", "wood", 0), ("landuse", "forest", 0),
           ("natural", "heath", 1), ("natural", "scrub", 2)]


def classify(tags):
    for k, v, c in NAT_CLS:
        if tags.get(k) == v:
            return c
    return None


def rel_query(box):
    s, w, n, e = box
    bb = f"({s},{w},{n},{e})"
    return (
        '[out:json][timeout:180];('
        f'relation["natural"~"^(wood|heath|scrub)$"]{bb};'
        f'relation["landuse"="forest"]{bb};'
        ');out geom;'
    )


def fetch_relations(box, cache_dir):
    """Per-tile relation fetch through the cached/backing-off overpass()."""
    s, w, n, e = box
    name = f"natrel_{s:.3f}_{w:.3f}_{n:.3f}_{e:.3f}.json"
    return overpass(rel_query(box), name, cache_dir)


def stitch_outers(rel):
    """Chain 'outer' member ways into closed rings of (lat, lon) tuples."""
    segs = []
    for m in rel.get("members", []):
        if m.get("type") != "way" or m.get("role") not in ("outer", ""):
            continue
        g = m.get("geometry") or []
        if len(g) >= 2:
            segs.append([(p["lat"], p["lon"]) for p in g])
    rings = []
    # exact-endpoint stitching with a tiny snap (OSM shares nodes, so exact
    # matches are the norm; snap covers float noise)
    def key(pt):
        return (round(pt[0], 6), round(pt[1], 6))
    unused = list(segs)
    while unused:
        chain = unused.pop()
        changed = True
        while changed and key(chain[0]) != key(chain[-1]):
            changed = False
            for i, seg in enumerate(unused):
                if key(seg[0]) == key(chain[-1]):
                    chain = chain + seg[1:]
                elif key(seg[-1]) == key(chain[-1]):
                    chain = chain + seg[-2::-1]
                elif key(seg[-1]) == key(chain[0]):
                    chain = seg + chain[1:]
                elif key(seg[0]) == key(chain[0]):
                    chain = seg[::-1] + chain[1:]
                else:
                    continue
                unused.pop(i)
                changed = True
                break
        if len(chain) >= 4 and key(chain[0]) == key(chain[-1]):
            rings.append(chain[:-1])
    return rings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--data", default="public/archipelago_data.json")
    ap.add_argument("--map", dest="map_path", default="public/archipelago_map.json")
    ap.add_argument("--max-mb", type=float, default=8.9)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    raw = open(args.data, encoding="utf-8").read()
    data = json.loads(raw)
    existing = data.get("nature", [])
    print(f"existing nature records: {len(existing)}")

    # existing same-class centroid index for dedupe (60 m grid)
    ex_idx = {}
    for rec in existing:
        pts = rec["p"]
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        a = abs(shoelace2(pts)) * 0.5
        ex_idx.setdefault((rec["c"], round(cx / 60), round(cz / 60)), []).append(a)

    def dup_existing(c, cx, cz, a):
        gx, gz = round(cx / 60), round(cz / 60)
        for dgx in (-1, 0, 1):
            for dgz in (-1, 0, 1):
                for ea in ex_idx.get((c, gx + dgx, gz + dgz), []):
                    if 0.5 <= (a / ea if ea else 99) <= 2.0:
                        return True
        return False

    mapd = json.loads(open(args.map_path, encoding="utf-8").read())
    coast = build_coast(mapd)
    print("coast grid ready")

    tiles = [t for t in tiles_for(BOX) if tile_has_coast(coast, t)]
    print(f"{len(tiles)} coast tiles")

    seen_rel = set()
    added = []
    jurmo_heath_m2 = 0.0
    for i, t in enumerate(tiles):
        try:
            resp = fetch_relations(t, args.cache)
        except Exception as e:  # stonewall etc — keep what we have, report
            print(f"tile {i}: FETCH FAILED {e}")
            continue
        for el in resp.get("elements", []):
            if el.get("type") != "relation" or el["id"] in seen_rel:
                continue
            seen_rel.add(el["id"])
            c = classify(el.get("tags", {}))
            if c is None:
                continue
            for ring in stitch_outers(el):
                pts = [proj(lon, lat) for (lat, lon) in ring]
                pts = dedupe([(round(x), round(z)) for (x, z) in pts])
                if len(pts) < 3:
                    continue
                tol = RDP_TOL
                simp = rdp(pts, tol)
                while len(simp) > MAX_PTS:
                    tol *= 1.5
                    simp = rdp(pts, tol)
                if len(simp) < 3:
                    continue
                a = abs(shoelace2(simp)) * 0.5
                if a < max(NATURE_MIN_AREA, 300.0):
                    continue
                if not any_near(coast, simp, COAST_R):
                    continue
                cx = sum(p[0] for p in simp) / len(simp)
                cz = sum(p[1] for p in simp) / len(simp)
                if dup_existing(c, cx, cz, a):
                    continue
                added.append({"c": c, "p": [[int(p[0]), int(p[1])] for p in simp]})
                if c == 1 and 3300 <= cx <= 8200 and -2900 <= cz <= -1200:
                    jurmo_heath_m2 += a
        if (i + 1) % 10 == 0:
            print(f"  tile {i + 1}/{len(tiles)} — {len(added)} records so far")

    print(f"NEW relation records: {len(added)}")
    print(f"Jurmo-area heath added: {jurmo_heath_m2 / 1e6:.2f} km^2")
    by_c = {}
    for r in added:
        by_c[r["c"]] = by_c.get(r["c"], 0) + 1
    print(f"by class: {by_c}")

    if not added:
        print("nothing to add (already baked?) — exiting clean")
        return
    if jurmo_heath_m2 < 8e5:
        print("WARNING: Jurmo heath under 0.8 km^2 — relations may be missing from OSM or the fetch failed there")

    addition = ",".join(json.dumps(r, separators=(",", ":")) for r in added)
    new_raw = append_into(raw, "nature", addition)
    mb = len(new_raw.encode("utf-8")) / 1e6
    print(f"new size: {mb:.2f} MB (cap {args.max_mb})")
    if mb > args.max_mb:
        print("FATAL: over budget — raise the area floor or the cap knowingly")
        sys.exit(1)
    # byte-stability gate: the original text minus the closing must be a prefix
    if not new_raw.startswith(raw[:array_span(raw, "nature")[1] - 1]):
        print("FATAL: splice broke byte stability")
        sys.exit(1)
    if args.dry_run:
        print("dry run — not writing")
        return
    open(args.data, "w", encoding="utf-8").write(new_raw)
    print("written.")


if __name__ == "__main__":
    main()

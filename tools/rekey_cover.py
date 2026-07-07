#!/usr/bin/env python3
"""Re-key public/archipelago_cover.json for an expanded map.

The cover file (esri z14 land-cover, baked by bake_landcover.py) is keyed by
ISLAND INDEX into public/archipelago_map.json, and its grid entries store
x0/z0 in ISLAND-LOCAL coordinates — relative to the island's vertex-mean
centroid, the same arithmetic archipelago.js uses. When the map is rebuilt
(new bbox, new OSM extract) both things break: indices shuffle and, because
rings gain/lose vertices, centroids drift. This tool fixes both without
re-downloading a single satellite tile:

  * keys are translated old->new through a remap JSON ({old_idx: new_idx},
    produced by the map-expansion bake by matching rings),
  * grid entries ({x0,z0,dx,dz,nx,nz,b64}) get x0/z0 shifted by
    (old centroid - new centroid) so the grid stays glued to the same WORLD
    position; dominant-class entries ({d}) are re-keyed as-is,
  * old index 0 (Storlandet) is carried manually: the remap skips it because
    its OSM ring genuinely grew, so it is matched by name (n='Storlandet',
    largest area) in the new map and shifted with the same delta rule,
  * old indices absent from the remap are dropped (their islands left the
    map or were deduplicated); non-injective remap collisions are resolved
    deterministically (payload-identical duplicates keep the lowest old key).

Gates (exit nonzero on failure): every shifted grid keeps its world origin
within 6 cm of the old one; no target record is a mainland tile; output is
within ±15 % of the input size and parses.

Typical invocation (paths from the expanded-world bake session):
  python3 tools/rekey_cover.py \
    --cover-old <scratch>/old_cover_snapshot.json \
    --map-old   <scratch>/old_map_snapshot.json \
    --map-new   <scratch>/map_expanded_raw.json \
    --remap     <scratch>/cover_remap.json \
    --out       public/archipelago_cover.json
"""
import argparse, json, math, sys

import numpy as np


def centroid(rec):
    p = np.asarray(rec["p"], dtype=np.float64)
    return float(p[:, 0].mean()), float(p[:, 1].mean())


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cover-old", required=True, help="cover keyed to the OLD map")
    ap.add_argument("--map-old", required=True, help="OLD shipping map (old centroids)")
    ap.add_argument("--map-new", required=True, help="NEW raw map (new centroids)")
    ap.add_argument("--remap", required=True, help="old->new island index JSON")
    ap.add_argument("--out", required=True, help="output cover JSON")
    args = ap.parse_args()

    cover = json.load(open(args.cover_old))
    old_isl = json.load(open(args.map_old))["islands"]
    new_isl = json.load(open(args.map_new))["islands"]
    remap = json.load(open(args.remap))

    # manual Storlandet carry is ONLY needed when the remap skipped old index 0
    # (its OSM ring grew between bakes, as in the pre-expansion -> Uto/Porvoo
    # migration). When the remap already covers "0" (the usual case, and the
    # case for the Aland migration where old index 0 is Kimitoon), use it
    # directly — no name-matching special case.
    carry_zero = "0" not in remap
    storlandet_new = None
    if carry_zero:
        storlandet_new = max(
            (i for i, r in enumerate(new_isl) if r.get("n") == "Storlandet"),
            key=lambda i: new_isl[i]["a"], default=None)
        if storlandet_new is None:
            sys.exit("FATAL: no 'Storlandet' in the new map — cannot carry old index 0")
        if old_isl[0].get("n") != "Storlandet":
            sys.exit("FATAL: old index 0 is not Storlandet — the manual carry rule no longer applies")

    def target_of(old_key):
        if old_key == "0" and carry_zero:
            return storlandet_new
        return remap.get(old_key)

    # resolve non-injective remap collisions among cover keys: keep the lowest
    # old key; refuse silently-diverging payloads
    by_target = {}
    for k in sorted(cover["islands"], key=int):
        t = target_of(k)
        if t is None:
            continue
        by_target.setdefault(t, []).append(k)
    drop_dupes = set()
    n_collisions = 0
    for t, keys in by_target.items():
        if len(keys) > 1:
            n_collisions += 1
            keep = keys[0]
            for k in keys[1:]:
                if cover["islands"][k] != cover["islands"][keep]:
                    sys.exit(f"FATAL: old cover keys {keys} collide on new index {t} "
                             "with DIFFERENT payloads — resolve the remap upstream")
                drop_dupes.add(k)

    out_islands = {}
    n_grid = n_class = n_drop = 0
    shift_err_max = 0.0
    storlandet_delta = None
    for k in sorted(cover["islands"], key=int):
        t = target_of(k)
        if t is None or k in drop_dupes:
            n_drop += t is None
            continue
        rec_new = new_isl[t]
        if rec_new.get("k") == "mainland":
            sys.exit(f"FATAL: old cover key {k} remaps to mainland tile {t}")
        entry = cover["islands"][k]
        if "x0" in entry:                             # grid entry: shift to the new centroid
            ocx, ocz = centroid(old_isl[int(k)])
            ncx, ncz = centroid(rec_new)
            dx, dz = ocx - ncx, ocz - ncz
            if k == "0" and carry_zero:
                storlandet_delta = (dx, dz, math.hypot(dx, dz), t)
            e2 = dict(entry)
            e2["x0"] = round(entry["x0"] + dx, 1)
            e2["z0"] = round(entry["z0"] + dz, 1)
            # world-anchor check: old world origin == new world origin (± rounding)
            err = math.hypot((ocx + entry["x0"]) - (ncx + e2["x0"]),
                             (ocz + entry["z0"]) - (ncz + e2["z0"]))
            shift_err_max = max(shift_err_max, err)
            out_islands[str(t)] = e2
            n_grid += 1
        else:                                         # dominant-class entry: key change only
            out_islands[str(t)] = entry
            n_class += 1

    out = {"meta": cover["meta"],
           "islands": {k: out_islands[k] for k in sorted(out_islands, key=int)}}
    blob = json.dumps(out, separators=(",", ":"))
    with open(args.out, "w") as f:
        f.write(blob)

    # ---- report + gates ----
    old_size = len(json.dumps(cover, separators=(",", ":")))
    print(f"cover entries in: {len(cover['islands'])}  out: {len(out_islands)}")
    print(f"  grid entries shifted: {n_grid}  class entries re-keyed: {n_class}")
    print(f"  dropped (unmapped old indices): {n_drop}  "
          f"collision duplicates folded: {len(drop_dupes)} ({n_collisions} targets)")
    if storlandet_delta:
        dx, dz, dist, t = storlandet_delta
        print(f"  Storlandet carried: old 0 -> new {t}, centroid delta "
              f"({dx:+.1f}, {dz:+.1f}) m = {dist:.1f} m")
    else:
        print("  Storlandet: old 0 had no grid entry (class-only or absent)")
    print(f"  max world-anchor error after shift: {shift_err_max*100:.1f} cm")
    print(f"  size: {old_size/1e6:.2f} MB -> {len(blob)/1e6:.2f} MB "
          f"({(len(blob)/old_size - 1)*100:+.1f}%)")

    fails = []
    def chk(cond, msg):
        print(f"  {'OK  ' if cond else 'FAIL'} {msg}")
        if not cond:
            fails.append(msg)
    # x0/z0 keep the file's 1-decimal style, so the worst legal anchor error
    # is the rounding diagonal sqrt(2)*0.05 m = 7.1 cm (vs 12-127 m cells)
    chk(shift_err_max <= 0.072, "every shifted grid keeps its world origin (<=7.2 cm rounding bound)")
    chk(abs(len(blob) / old_size - 1) <= 0.15, "output size within ±15% of input")
    chk(json.load(open(args.out)) == out, "output parses and round-trips")
    chk("0" not in cover["islands"] or str(storlandet_new) in out_islands,
        "Storlandet entry present in output")
    if fails:
        sys.exit(1)
    print("all cover gates passed")


if __name__ == "__main__":
    main()

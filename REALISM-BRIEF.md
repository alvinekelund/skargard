# Realism brief — "I want to feel like I'm sailing there"

Owner feedback, July 2026. The bar: not "nice", but *being there*. Alvin knows
these waters personally; every shortcut reads as fake to him. No sloppiness,
no "good enough" — proportions, quality, craftsmanship. Each item below is a
complaint translated into work; verify every fix against real photos or data,
not against intuition.

## 1. Island profiles — kill the walls

**Complaint:** many islands rise almost vertically from the water, "like a
wall". Predictable, repeated silhouettes. Real Archipelago Sea islands are
glacially smoothed whalebacks: gentle bare-granite aprons sliding into the
sea, rounded crowns, almost never cliffs (rare exceptions on exposed south
sides).

- Audit the shore-to-interior height ramp in `src/archipelago.js` (and the
  "no more mesas" fix in git history — it helped, not enough).
- Procedural (orange-ring) islands must use a whaleback profile: slope in the
  first 30–80 m from shore should typically be 5–15°, not 45°+.
- Height sanity: most outer skerries top out at 5–15 m, larger outer islands
  20–40 m. Anything auto-generated above that is wrong.
- Verification: render silhouettes of 10 known islands (Jurmo, Utö, Aspö,
  Nötö, Berghamn…) and compare against photos + DEM cross-sections.

## 2. Elevation data — use it properly

**Complaint:** "if you have the height data, you should be able to get the
height correctly."

- Audit `tools/bake_elevation.py`: what source, what resolution, what
  sampling? If it's a coarse global DEM (30 m class), that's the problem —
  skerries and small islands vanish or turn into cones at that resolution.
- Switch to the **NLS Finland open DEM (2 m grid)** from Maanmittauslaitos
  (free, covers the whole archipelago). Bilinear sampling, no vertical
  exaggeration, 1:1.
- Goal: the teal (measured) rings should cover essentially every island in
  the play area; the orange procedural fallback becomes the rare exception.

## 3. Real harbors — recreate the famous ones

**Complaint:** the popular harbors are "so far from being accurate".

- Pick the harbors people actually know: **Nauvo/Nagu guest harbor, Korpo,
  Utö, Jurmo, Aspö, Nötö, Berghamn** (extend as needed). Look each one up
  (aerial imagery + harbor guides) and rebuild from reference:
  breakwaters, quay lines, pontoon orientation, fuel dock, red boathouses,
  the characteristic buildings.
- Suggested mechanism: a per-harbor descriptor (JSON: quays, pontoons,
  buildings, moored-boat rows) hand-tuned against the aerial photo, layered
  over the OSM base.

## 4. Land cover must match the satellite photo

**Complaint:** "with my eyes I can clearly see from the satellite if it's
forest, meadow, rock or road — make the island actually look like that."

- `bake_landcover.py` + "the photo decides the forest" started this; push it
  to per-pixel truth: classify the draped imagery (or higher-zoom tiles,
  z16–17) into forest / meadow-field / bare granite / road / built, and make
  the 3D props agree with the drape *exactly* — trees only where the photo
  is forest, open grass where it's meadow, clean rock where it's rock.
- Add reed belts in sheltered shallow bays (they're everywhere in real life).

## 5. Vessel scale — everyone knows what these look like

**Complaint:** the big ferries look like toys; small boats are all one size.

Real dimensions (verify, don't trust memory):
- **Viking Glory**: 222 m LOA, ~35 m beam, ~12 passenger decks, red/white
  Viking livery.
- **Silja Serenade**: 203 m LOA, white hull, blue SILJA LINE lettering.
  (If the Turku route matters for accuracy, the Turku ships are Baltic
  Princess / Galaxy class ~212 m — pick the right ships for the fairway.)
- Road ferry (lossi): ~50–60 m, yellow.
- Utö connection vessel: ~25–35 m.
- Guest-harbor cruisers and archipelago motorboats: 6–12 m — comparable to
  the Swan, not dinghies.
- Add a scale-audit table in code: every vessel class with real LOA; render
  the Swan 36 (11 m) next to Viking Glory — the ferry should feel like a
  moving building.

## 6. Summer traffic and full harbors

**Complaint:** it's summer — harbors should be almost full, and there should
be real traffic on the water.

- Guest harbors: pontoons lined with 30–45 ft sailboats and motor cruisers,
  boats anchored in the popular bays.
- Open water: other sailboats actually sailing (heeled, correct sail shapes,
  varied courses) and motorboats of Swan-comparable size, densest along the
  fairways and near harbors.

## 7. Trees — real Nordic forest, not bushes

**Complaint:** trees read proportionally ~5 m, "like bushes".

- Target mature pine/spruce canopy ~20–30 m on the wooded inner islands;
  wind-stunted, sparser and shorter on the exposed outer islands; a
  deciduous mix (birch) near villages and meadows.
- Sanity check: a tree next to a 2-storey house must dwarf it, not match it.

## 8. Missing buildings

**Complaint:** in some places all houses are missing (e.g. the south side of
Biskopsö-area); real settlement is fairly evenly spread.

- OSM building coverage is patchy out here. Supplement the bake with the
  **NLS topographic database buildings layer** (open data, near-complete
  coverage) merged with OSM.
- QA: for a sample of islands, count baked buildings vs. what the satellite
  photo shows.

## Working method (applies to every item)

1. Reference first: real photo / DEM / chart before touching code.
2. Fix the *data or generator*, not the single instance.
3. Verify visually at places Alvin knows: Utö village, Jurmo heath, Nauvo
   guest harbor, the Turku–Åland fairway crossing.
4. Screenshot before/after for each item; the standard is "could fool
   someone who has been there", not "looks nice".

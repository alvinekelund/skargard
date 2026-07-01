# Skärgård — sail the Finnish archipelago

A relaxing, good-feel sailing game set in the REAL Archipelago Sea: 550+ actual
island outlines from OpenStreetMap around **Utö and Jurmo**, with their real names,
Finland's oldest lighthouse on the real Utö, and a procedurally lofted **Nautor
Swan 36** to sail between them. Real points of sail, heavy-displacement momentum,
Gerstner waves, and a wake that reacts to how you sail. Built in real-time WebGL
with [Three.js](https://threejs.org).

![Skärgård](preview.jpg)

## Run it

```bash
npm install
npm run dev      # → http://localhost:5183
```

**Controls** — `←/→` steer · `↑/↓` trim the sail · `C` camera (chase → **helm POV** → orbit) · `T` time of day (day / golden hour)

## How it feels

- **The boat is a Swan 36** (S&S 1967), lofted in code from a real station table —
  long overhangs, low trunk, fin keel, masthead sloop, teak deck, boot stripe.
- **Sailing is heavy-displacement real**: no-go zone (*in irons*), fastest on a
  reach, hull-speed wall at ~7.8 kn, ~10 s to wind up from a standstill, carries
  way through a tack, and a hard rudder scrubs a third of your speed. Heel is a
  spring — a gust leans her over a beat later, then she settles.
- **The sea is alive**: Gerstner waves with peaked crests, capillary sparkle in the
  sun path, and a wake that widens and brightens with speed *and* throws a skidding
  wash outboard when you turn hard. The HUD names where you are (real chart names).
- **The chart is real**: every island is an actual OSM coastline polygon from the
  outer Archipelago Sea (bbox around 59.8°N 21.5°E, uniformly compressed 0.28×),
  rebaked via `public/archipelago_map.json`. Jurmo is the big treeless heath it
  really is; the lighthouse and pilot village stand on the real Utö.

## How it's made

One coherent light drives the whole scene; everything below shares it.

- **The archipelago** is the heart of it, modelled on the real outer Archipelago Sea
  (**Jurmo** and **Utö**). Each skerry is a **domain-warped union of metaballs** (never a
  radial dome — that's the tell that reads as a "snowy mound"), with height from the field
  so the islands are low, flat, glacier-smoothed granite whalebacks (H/R ≈ 0.05–0.12).
  ~100 islands cluster into shoals with navigable channels: mostly bare-rock skerries
  carpeted in **heather heath and low horizontal juniper** (Jurmo) with scattered moraine
  boulders, trees only on the bigger forested islands and the two landmasses — and a
  **Utö-style lighthouse** (red-and-white striped tower, green dome, flashing light) above
  a little red-and-white pilot village as a landmark. You can't sail through islands —
  the hull grounds on the rock and slides along the shore.
- **Granite** is real PBR rock: triplanar-mapped colour/normal/roughness maps
  (Poly Haven, two noise-blended world-space scales so it never tiles) under the
  vertex-coloured ecological tints — wet-waterline → grey/pink rock → orange lichen →
  moss crowns — with a glossy wet band and an animated foam line at the shore.
- **Light is honest**: the sun casts real PCF-soft shadows (trees, rocks, boat,
  lighthouse) from a shadow camera that follows the boat.
- **Sea** keeps Three's planar reflection but is biased toward a saturated Baltic
  teal (softer mirror, brighter body colour) so it reads as water, not a grey mirror.
- **Trees** are instanced pines + birches, sun-rim-lit with a vertex-shader breeze;
  the **wake** is a dynamic foam ribbon laid behind the boat, widening and fading astern.
- **Sky/light** is a Preetham sky feeding a PMREM environment (re-baked on the
  time-of-day switch), with HDR bloom → ACES → a restrained grade.

Most tuning lives in `PRESETS` in [`src/environment.js`](src/environment.js), the
sailing constants in [`src/boat.js`](src/boat.js), and the island generator in
[`src/archipelago.js`](src/archipelago.js).

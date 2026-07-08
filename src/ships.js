import * as THREE from 'three';

/* Ship traffic on its REAL routes — just a few, where they would actually be.
   · Viking Line + Silja Line cruise ferries on the Turku–Åland deep fairway
     crossing the north of the map (offset parallel tracks)
   · a yellow Finferries road ferry shuttling the short Korpo–Norrskata-style
     crossing (Kyrklandet ↔ Ängsö)
   · the yellow archipelago connection vessel working the Utö line past
     Nötö/Aspö down to Utö
   Waypoints were path-found against the baked island polygons and validated
   ≥ 150 m (measured ≥ 218 m) from every shoreline along their whole length. */

// Viking Line + Silja Line run the REAL Turku–Åland fairway: down Airisto off
// Turku, through the Kihti/Skiftet strait, across Delet to the Mariehamn
// approach. A*-path-found against the 47k-island map and validated clean
// (viking min 111 m clearance over 1,458 samples, silja min 106 m) — the
// inner-harbour + west-of-Åland legs don't route, so the line terminates in
// the Mariehamn fairway, which is a real call; the ferries ply it both ways.
export const ROUTES = {
  viking: [[31925, -65115], [34550, -63630], [28382, -51412], [18148, -49497], [14551, -46579], [6308, -45363], [-1251, -42035], [-3010, -41190], [-12491, -34404], [-36792, -34089], [-48927, -41237], [-50290, -41150], [-52413, -39255], [-53364, -36180], [-54704, -36403], [-56598, -36893], [-59921, -37062], [-62992, -38905], [-63565, -41750], [-64390, -41970], [-66540, -40371], [-69018, -40517], [-71212, -40703], [-79669, -34057], [-79330, -33210], [-81429, -32062], [-82315, -32835]],
  silja: [[31775, -64845], [34490, -63810], [28205, -51645], [18035, -49755], [14435, -46845], [10550, -47850], [6530, -45450], [-1390, -41910], [-3115, -41415], [-8530, -36570], [-15970, -32970], [-35110, -33630], [-42610, -35970], [-48310, -41310], [-50395, -41415], [-52675, -39405], [-53290, -36330], [-55090, -36030], [-56545, -37185], [-59530, -37890], [-62650, -38550], [-63355, -41955], [-64690, -42510], [-66310, -40410], [-69070, -40470], [-71305, -40995], [-79945, -34125], [-79450, -33450], [-81310, -32070], [-82015, -32955]],
  roadferry: [[10222, -35272], [11010, -34857], [11798, -34441]],
  utoline: [[12705, -32785], [12270, -31810], [13005, -15685], [7785, -15085], [6930, -13270], [4050, -9370], [2310, -1510], [2865, -835], [630, -490], [-4890, 2930], [-5355, 2585]],
};

function box(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// a lit window strip (warm emissive) — reads as passenger decks at dusk
function windows(len, y, z, g, h = 1.4) {
  g.add(box(len, h, 0.4, 0, y, z, new THREE.MeshStandardMaterial({
    color: 0x1a2026, roughness: 0.4, emissive: 0xffc878, emissiveIntensity: 0.55,
  })));
}

// a hull/deck block whose plan has a rounded, raked front (bow at +x) — extruded
// upward. This is what keeps the ferries from reading as stacked cardboard boxes.
function shipBlock(l, b, h, mat, taper = 0.16, sternRound = 0.12) {
  const ft = l * taper, sr = b * sternRound;
  const s = new THREE.Shape();
  s.moveTo(-l / 2 + sr, -b / 2);
  s.lineTo(l / 2 - ft, -b / 2);
  s.quadraticCurveTo(l / 2, -b / 2, l / 2, -b * 0.16);
  s.quadraticCurveTo(l / 2 + ft * 0.35, 0, l / 2, b * 0.16);   // stem point
  s.quadraticCurveTo(l / 2, b / 2, l / 2 - ft, b / 2);
  s.lineTo(-l / 2 + sr, b / 2);
  s.quadraticCurveTo(-l / 2, b / 2, -l / 2, 0);                // rounded stern
  s.quadraticCurveTo(-l / 2, -b / 2, -l / 2 + sr, -b / 2);
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);                                   // extrude +Z → +Y up
  return new THREE.Mesh(geo, mat);
}

// cabin-window strip: dark plating with individual lit panes (a few dark),
// so deck rows read as rows of windows instead of painted yellow bands
let _stripTex = null;
function windowStripTexture() {
  if (_stripTex) return _stripTex;
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#151a20'; ctx.fillRect(0, 0, 1024, 64);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let x = 6; x < 1024 - 18; x += 22) {
    const lit = rnd() < 0.78;
    ctx.fillStyle = lit ? `rgb(255,${196 + Math.floor(rnd() * 40)},${100 + Math.floor(rnd() * 40)})` : '#242c34';
    ctx.fillRect(x, 14, 15, 36);
  }
  _stripTex = new THREE.CanvasTexture(cv);
  _stripTex.wrapS = THREE.RepeatWrapping;
  _stripTex.colorSpace = THREE.SRGBColorSpace;
  return _stripTex;
}
// one texture repeat ≈ 46 windows ≈ 102 m of plating — scale the box UVs
// so panes stay ~2.2 m wide whatever the strip length
function windowStrip(len, h, x, y, z) {
  const geo = new THREE.BoxGeometry(len, h, 0.3);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * len / 102);
  const tex = windowStripTexture();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.5,
    color: 0x8a8f96, roughness: 0.35, metalness: 0.15,
  }));
  m.position.set(x, y, z);
  return m;
}

// the line's name painted huge along the hull side — the single strongest
// identity carrier these ships have. Canvas → alpha texture on a thin
// plane riding just off the plating (one mirrored copy per side).
function letteringTexture(text, color) {
  const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 256;
  const ctx = cv.getContext('2d');
  ctx.font = '900 168px "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '26px';
  ctx.fillStyle = color;
  ctx.fillText(text, 1024, 138);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
// the 180° yaw on the port copy flips facing AND apparent text direction —
// they cancel, so one unmirrored texture serves both sides
function hullLettering(g, text, color, len, hgt, x, y, halfB) {
  const tex = letteringTexture(text, color);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, alphaTest: 0.04, roughness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1,
  });
  for (const s of [1, -1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(len, hgt), mat);
    p.position.set(x, y, s * halfB);
    p.rotation.y = s === 1 ? 0 : Math.PI;
    g.add(p);
  }
}

/* ── SCALE AUDIT — real vessels, real LOA. The Swan 36 is 11 m; a Baltic
   cruise ferry alongside her must feel like a moving building.
     Viking Glory      222 m LOA · 35 m beam · superstructure to ~50 m
     Silja Serenade    203 m LOA · 32 m beam · white hull, blue band
     road ferry lossi   50 m
     Utö connection     27 m
     guest-harbour yachts/cruisers 6–12 m (comparable to the Swan)          ── */
const FERRY_DIMS = {
  viking: { L: 222, B: 35 },   // Viking Glory, Turku–Åland–Stockholm
  silja: { L: 203, B: 32 },    // Silja Serenade class
  tallink: { L: 212, B: 31 },  // Tallink Megastar / Baltic Princess, Helsinki–Tallinn
};

// a Baltic cruise ferry at TRUE scale, built to be recognised, not just seen:
//   Viking Glory — dark Viking-red hull with a snub near-vertical stem, white
//     VIKING LINE along the plating, white superstructure wearing the black
//     glass band, one red funnel.
//   Silja Serenade — tall white slab of a hull, blue SILJA LINE lettering,
//     long unbroken window strips, one white funnel with the blue top.
function cruiseFerry(scheme) {
  const g = new THREE.Group();
  const viking = scheme === 'viking';
  const hullMat = new THREE.MeshStandardMaterial({ color: viking ? 0xa11e22 : 0xf0f2f1, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const boot = new THREE.MeshStandardMaterial({ color: 0x141821, roughness: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f5f2, roughness: 0.5, side: THREE.DoubleSide });
  const accent = new THREE.MeshStandardMaterial({ color: viking ? 0xbe2f26 : 0xf4f5f2, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.35, metalness: 0.3 });
  const blackGlass = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.15, metalness: 0.4, emissive: 0x2b3d4d, emissiveIntensity: 0.25 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x1c3f94, roughness: 0.5 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xe8631c, roughness: 0.6 });

  const { L, B } = FERRY_DIMS[scheme];
  const Hh = 12, draft = 6.5;
  // Glory's modern stem is snub and near-vertical; Serenade's is a classic rake
  const hull = shipBlock(L, B, Hh + draft, hullMat, viking ? 0.08 : 0.17);
  hull.position.y = -draft;
  const bootStripe = shipBlock(L * 1.002, B + 0.3, 1.2, boot, viking ? 0.08 : 0.17);
  bootStripe.position.y = 0.15;
  g.add(hull, bootStripe);

  // superstructure: six inset tiers with rounded fronts + lit window rows —
  // ~50 m from the waterline to the top deck, like the real ships
  const tiers = [
    { l: L * 0.95, b: B - 1.5, h: 6.6 },
    { l: L * 0.92, b: B - 2.5, h: 6.2 },
    { l: L * 0.86, b: B - 4.0, h: 6.0 },
    { l: L * 0.76, b: B - 7.0, h: 5.8 },
    { l: L * 0.6, b: B - 11, h: 5.4 },
    { l: L * 0.4, b: B - 16, h: 4.8 },
  ];
  let y = Hh;
  const tierX = [];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const blk = shipBlock(t.l, t.b, t.h, white, 0.12);
    blk.position.set(-(L - t.l) * 0.12, y, 0);
    tierX.push(-(L - t.l) * 0.12);
    g.add(blk);
    if (viking && (i === 2 || i === 3)) {
      // the Glory black-glass band, flowing full-length around those decks
      const bb = shipBlock(t.l * 0.98, t.b + 0.35, t.h * 0.82, blackGlass, 0.12);
      bb.position.set(-(L - t.l) * 0.12, y + t.h * 0.09, 0);
      g.add(bb);
    } else {
      // window rows: Serenade's read as long strips, Glory's as two rows —
      // both built from individual lit panes, not painted bands
      const rows = viking ? [y + t.h * 0.32, y + t.h * 0.72] : [y + t.h * 0.45];
      const wh = viking ? t.h * 0.26 : t.h * 0.4;
      for (const wy of rows) {
        for (const s of [1, -1]) {
          g.add(windowStrip(t.l * 0.84, wh, -(L - t.l) * 0.12 - t.l * 0.03, wy, s * (t.b / 2 + 0.05)));
        }
      }
    }
    y += t.h;
  }
  // the line's name, huge along the side. Glory carries it white on the red
  // hull; Serenade blue on the tall white hull — spanning two deck heights.
  if (viking) {
    hullLettering(g, 'VIKING LINE', '#f4f6f8', L * 0.55, 6.2, -L * 0.02, Hh * 0.5, B / 2 + 0.2);
  } else if (scheme === 'tallink') {
    hullLettering(g, 'TALLINK', '#d1232a', L * 0.42, 7.5, -L * 0.02, Hh * 0.62, B / 2 + 0.2);
  } else {
    hullLettering(g, 'SILJA LINE', '#1c3f94', L * 0.6, 7.5, -L * 0.02, Hh * 0.62, B / 2 + 0.2);
  }
  // lifeboats slung along the boat deck (orange, both sides)
  for (const s of [1, -1]) for (let k = 0; k < 8; k++) {
    const lb = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 5.4, 3, 6), orange);
    lb.rotation.z = Math.PI / 2;
    lb.position.set(L * 0.26 - k * 11, Hh + 13.5, s * (B / 2 - 0.7));
    g.add(lb);
  }
  // ONE funnel (both real ships): Glory's red, Serenade's white w/ blue top
  const fn = shipBlock(16, 8, 11, accent, 0.22);
  fn.position.set(-L * 0.26, y, 0);
  const cap = viking
    ? box(12.5, 1.8, 6.4, -L * 0.26 - 0.5, y + 11, 0, dark)
    : box(13.5, 3.2, 6.8, -L * 0.26 - 0.5, y + 10.4, 0, blue);
  g.add(fn, cap);
  // foremast + radar
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 16, 6), dark);
  mast.position.set(L * 0.3, Hh + 16, 0);
  g.add(mast);
  return g;
}

// a yellow double-ended road ferry (lossi), rebuilt properly: shaped hull with
// a black waterline, bulwarks with cap rails, fenders that actually hang on
// the hull, A-frame ramp gantries with sheaves and cables, lane markings, a
// glazed wheelhouse up on legs, life rings, nav masts
function roadFerry() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c218, roughness: 0.55 });
  const yellowD = new THREE.MeshStandardMaterial({ color: 0xcf9f0e, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f0ea, roughness: 0.5 });
  const deckM = new THREE.MeshStandardMaterial({ color: 0x565a5e, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xe8631c, roughness: 0.6 });
  const lane = new THREE.MeshStandardMaterial({ color: 0xe8e6da, roughness: 0.8 });

  const hull = shipBlock(50, 12.5, 3.4, yellow, 0.1, 0.42);   // rounded both ends
  hull.position.y = -0.6;
  const boot = shipBlock(50.2, 12.7, 0.7, dark, 0.1, 0.42);   // waterline band
  boot.position.y = -0.55;
  g.add(hull, boot);
  const deck = box(44, 0.15, 11.6, 0, 2.85, 0, deckM);        // car deck
  g.add(deck);
  for (const s of [1, -1]) {
    g.add(box(44, 1.25, 0.4, 0, 3.5, s * 5.95, yellow));      // bulwark
    g.add(box(44.2, 0.16, 0.62, 0, 4.16, s * 5.95, yellowD)); // cap rail
    g.add(box(38, 0.08, 0.3, 0, 2.95, s * 3.1, lane));        // lane edge marking
    for (let k = 0; k < 6; k++) {                             // fenders hung on the hull side
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.16, 7, 12), dark);
      tyre.position.set(-17.5 + k * 7, 1.35, s * 6.28);       // flat against the plating
      g.add(tyre);
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 4), dark);
      rope.position.set(-17.5 + k * 7, 2.6, s * 6.22);
      g.add(rope);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.09, 6, 12), orange);
    ring.position.set(s * 6, 3.75, s * 5.7); g.add(ring);     // life rings on the bulwark
    // ramp + A-frame gantry with sheave and cables
    const ramp = box(5.6, 0.35, 10.6, s * 25.6, 3.6, 0, yellow);
    ramp.rotation.z = s * 0.52;
    g.add(ramp);
    for (const q of [1, -1]) {                                // A-frame legs lean together
      const leg = box(0.45, 7, 0.45, s * 22.3, 5.8, q * 4.4, yellow);
      leg.rotation.x = -q * 0.12;
      g.add(leg);
    }
    g.add(box(0.5, 0.55, 8.6, s * 22.3, 9.05, 0, yellow));    // crossbeam
    const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 10), steel);
    sheave.rotation.z = Math.PI / 2; sheave.position.set(s * 22.3, 9.0, 0);
    g.add(sheave);
    for (const q of [1, -1]) {                                // lift cables to the ramp corners
      const a = new THREE.Vector3(s * 22.3, 8.9, q * 0.3);
      const b = new THREE.Vector3(s * 27.6, 5.0, q * 4.6);
      const d = b.clone().sub(a);
      const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, d.length(), 4), dark);
      cable.position.copy(a).addScaledVector(d, 0.5);
      cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      g.add(cable);
    }
  }
  // glazed wheelhouse on four legs, offset to starboard like the real ones
  for (const [lx, lz] of [[1.2, 3.0], [4.8, 3.0], [1.2, 5.4], [4.8, 5.4]]) {
    g.add(box(0.3, 3.2, 0.3, lx, 4.6, lz, white));
  }
  g.add(box(4.6, 0.25, 3.4, 3, 6.2, 4.2, white));             // platform
  g.add(box(4.2, 2.6, 3.0, 3, 7.6, 4.2, white));              // house
  windows(3.8, 8.2, 5.75, g, 0.9);                            // glazing all around
  windows(3.8, 8.2, 2.68, g, 0.9);
  const wsSide = box(0.35, 0.9, 2.6, 0.95, 8.2, 4.2, new THREE.MeshStandardMaterial({
    color: 0x1a2026, roughness: 0.4, emissive: 0xffc878, emissiveIntensity: 0.55 }));
  g.add(wsSide);
  g.add(box(4.5, 0.18, 3.3, 3, 9.05, 4.2, white));            // roof
  const radar = box(1.3, 0.2, 0.28, 3, 9.5, 4.2, dark);
  g.add(radar);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 6), white);
  mast.position.set(3, 10.4, 4.2); g.add(mast);
  return g;
}

// the small yellow archipelago connection vessel (the Utö line): shaped hull,
// boot stripe, railed foredeck, proper deckhouse + bridge, mast and radar
function connectionVessel() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe8b414, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf0efe8, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.6 });
  const hull = shipBlock(27, 7.2, 4.6, yellow, 0.22, 0.2);
  hull.position.y = -1.6;
  g.add(hull);
  const boot = shipBlock(27.1, 7.4, 0.5, dark, 0.22, 0.2);    // waterline stripe
  boot.position.y = 0.1;
  g.add(boot);
  g.add(box(11, 2.8, 5.2, -2, 4.4, 0, white));                // deckhouse
  g.add(box(5, 2.2, 4.4, 1.5, 6.9, 0, white));                // bridge
  windows(9, 4.7, 2.7, g, 0.7); windows(9, 4.7, -2.7, g, 0.7);
  windows(4, 7.4, 2.3, g, 0.7); windows(4, 7.4, -2.3, g, 0.7);
  for (const s of [1, -1]) {                                  // foredeck rails
    const rail = box(9, 0.06, 0.06, 8, 4.0, s * 3.1, white);
    rail.rotation.z = -0.03;
    g.add(rail);
    for (let k = 0; k < 4; k++) g.add(box(0.06, 1.0, 0.06, 4.5 + k * 2.6, 3.5, s * 3.1, white));
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 3.2, 6), white);
  mast.position.set(3.5, 9.5, 0); g.add(mast);
  const radar = box(1.2, 0.22, 0.3, 3.5, 8.7, 0, dark);
  g.add(radar);
  return g;
}

export function createShips(scene) {
  const ships = [];

  function addShip(model, route, speed, startFrac, dir, fixedYaw = false, kind = '') {
    // arc-length table for steady motion along the polyline
    const seg = [];
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const d = Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]);
      seg.push(d); total += d;
    }
    // the models are built bow at +X, but the motion aligns +Z with the heading —
    // wrap so the bow points the way she's actually going (no more crabbing sideways)
    model.rotation.y = -Math.PI / 2;
    const mesh = new THREE.Group();
    mesh.add(model);
    mesh.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    scene.add(mesh);
    ships.push({ mesh, route, seg, total, speed, s: startFrac * total, dir, yaw: 0, init: false, fixedYaw, kind });
  }

  addShip(cruiseFerry('viking'), ROUTES.viking, 10.2, 0.25, 1, false, 'viking');   // ~20 kn service speed
  addShip(cruiseFerry('silja'), ROUTES.silja, 9.8, 0.7, -1, false, 'silja');
  addShip(roadFerry(), ROUTES.roadferry, 3.0, 0.4, 1, true, 'roadferry');  // a lossi never turns around
  addShip(connectionVessel(), ROUTES.utoline, 5.0, 0.55, 1, false, 'utoline');

  // BERTHED ferries at their real Helsinki terminals: a Viking Line ship at
  // Katajanokka, a Silja Line ship at the Olympia Terminal (South Harbour), a
  // Tallink ship at the West Terminal in Länsisatama. Moored (no motion), just
  // a gentle harbour bob.
  function addBerth(model, x, z, yaw, kind) {
    model.rotation.y = -Math.PI / 2;                 // bow +X → +Z
    const mesh = new THREE.Group();
    mesh.add(model);
    mesh.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    mesh.position.set(x, 0, z);
    mesh.rotation.y = yaw;
    scene.add(mesh);
    ships.push({ mesh, berthed: true, bx: x, bz: z, yaw, kind });
  }
  addBerth(cruiseFerry('viking'), 194840, -39820, 1.74, 'viking-berth');   // S side of Katajanokka
  addBerth(cruiseFerry('silja'), 194270, -39710, 0.4, 'silja-berth');      // Olympia Terminal (opposite)
  addBerth(cruiseFerry('tallink'), 191610, -38560, 2.36, 'tallink-berth'); // Länsiterminaali

  function posAt(ship, s) {
    let acc = 0;
    for (let i = 0; i < ship.seg.length; i++) {
      if (s <= acc + ship.seg[i]) {
        const t = (s - acc) / ship.seg[i];
        const a = ship.route[i], b = ship.route[i + 1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      acc += ship.seg[i];
    }
    const last = ship.route[ship.route.length - 1];
    return [last[0], last[1]];
  }

  function update(dt, t, waveHeightAt) {
    for (const sh of ships) {
      if (sh.berthed) {                              // moored — hold station, gentle bob
        sh.mesh.position.y = waveHeightAt ? waveHeightAt(sh.bx, sh.bz, t) * 0.15 : 0;
        continue;
      }
      sh.s += sh.speed * sh.dir * dt;
      if (sh.s > sh.total) { sh.s = sh.total; sh.dir = -1; }
      if (sh.s < 0) { sh.s = 0; sh.dir = 1; }
      const [x, z] = posAt(sh, sh.s);
      const ahead = sh.fixedYaw ? 1 : sh.dir;       // double-ended: heading never flips
      const [xa, za] = posAt(sh, Math.min(Math.max(sh.s + 30 * ahead, 0), sh.total));
      const targetYaw = Math.atan2(xa - x, za - z);
      if (!sh.init) { sh.yaw = targetYaw; sh.init = true; }
      // big ships come around slowly
      let d = targetYaw - sh.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      sh.yaw += d * (1 - Math.exp(-0.4 * dt));
      const bob = waveHeightAt ? waveHeightAt(x, z, t) * 0.25 : 0;
      sh.mesh.position.set(x, bob, z);
      sh.mesh.rotation.set(0, sh.yaw, 0);
    }
  }

  // live positions for the chart / minimap
  function markers() {
    return ships.map((sh) => ({ x: sh.mesh.position.x, z: sh.mesh.position.z, yaw: sh.yaw, kind: sh.kind }));
  }

  return { update, ships, markers };
}

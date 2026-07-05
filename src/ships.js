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

export const ROUTES = {
  viking: [[-16245, -35965], [-14430, -28570], [-4890, -25510], [-930, -21250], [6330, -22270], [18510, -29470], [25410, -28390], [26790, -27130], [30810, -27730], [33270, -25570], [34950, -27190], [45345, -29935]],
  silja: [[-16575, -35875], [-14117, -28160], [-4962, -25095], [-518, -21065], [3330, -22030], [18422, -29182], [25350, -28210], [27959, -27044], [30492, -27522], [33434, -25408], [34853, -27144], [45435, -29605]],
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

// a Baltic cruise ferry (Viking Line / Silja Line), ~170 m — a real silhouette:
// shaped hull, tiered superstructure with lit window rows, lifeboats, funnel
function cruiseFerry(scheme) {
  const g = new THREE.Group();
  const viking = scheme === 'viking';
  const hullMat = new THREE.MeshStandardMaterial({ color: viking ? 0xbe2f26 : 0xecefee, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const boot = new THREE.MeshStandardMaterial({ color: 0x141821, roughness: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f5f2, roughness: 0.5, side: THREE.DoubleSide });
  const accent = new THREE.MeshStandardMaterial({ color: viking ? 0xbe2f26 : 0x18408f, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.35, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x2b333d, roughness: 0.25, metalness: 0.2, emissive: 0xffca7a, emissiveIntensity: 0.55 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xe8631c, roughness: 0.6 });

  const L = 170, B = 27, Hh = 9.5, draft = 4.2;
  const hull = shipBlock(L, B, Hh + draft, hullMat);
  hull.position.y = -draft;
  const bootStripe = shipBlock(L * 1.002, B + 0.3, 1.0, boot);   // dark band at the waterline
  bootStripe.position.y = 0.15;
  g.add(hull, bootStripe);

  // superstructure: four inset tiers with rounded fronts + lit window rows
  const tiers = [
    { l: L * 0.94, b: B - 1.5, h: 6.0 },
    { l: L * 0.88, b: B - 3.0, h: 5.5 },
    { l: L * 0.74, b: B - 7.0, h: 5.0 },
    { l: L * 0.46, b: B - 13, h: 4.2 },
  ];
  let y = Hh;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const blk = shipBlock(t.l, t.b, t.h, white, 0.12);
    blk.position.set(-(L - t.l) * 0.12, y, 0);
    g.add(blk);
    // two window rows per tier
    for (const wy of [y + t.h * 0.32, y + t.h * 0.72]) {
      for (const s of [1, -1]) {
        const w = box(t.l * 0.8, t.h * 0.26, 0.3, -(L - t.l) * 0.12 - t.l * 0.04, wy, s * (t.b / 2 + 0.05), glass);
        g.add(w);
      }
    }
    y += t.h;
  }
  // lifeboats slung along the boat deck (orange, both sides)
  for (const s of [1, -1]) for (let k = 0; k < 6; k++) {
    const lb = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 4.2, 3, 6), orange);
    lb.rotation.z = Math.PI / 2;
    lb.position.set(L * 0.24 - k * 9, Hh + 5.5, s * (B / 2 - 0.6));
    g.add(lb);
  }
  // two funnels (line colours) with black tops, set aft
  for (const fx of [-L * 0.20, -L * 0.30]) {
    const fn = shipBlock(11, 6, 9, accent, 0.2);
    fn.position.set(fx, y, 0);
    const cap = box(9, 1.6, 5, fx - 0.5, y + 9, 0, dark);
    g.add(fn, cap);
  }
  // foremast + radar
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 14, 6), dark);
  mast.position.set(L * 0.28, Hh + 13, 0);
  g.add(mast);
  return g;
}

// a yellow double-ended road ferry (lossi): shaped symmetric hull, tire
// fenders, railed car deck, lifting ramp gantries, offset wheelhouse
function roadFerry() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c218, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f0ea, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.9 });
  const hull = shipBlock(50, 12.5, 4.2, yellow, 0.1, 0.42);   // rounded both ends
  hull.position.y = -1.4;
  g.add(hull);
  g.add(box(44, 1.3, 0.45, 0, 3.4, 5.9, yellow));             // bulwarks
  g.add(box(44, 1.3, 0.45, 0, 3.4, -5.9, yellow));
  for (const s of [1, -1]) {
    for (let k = 0; k < 6; k++) {                             // tire fenders
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.22, 6, 10), dark);
      tyre.position.set(-17.5 + k * 7, 1.5, s * 6.35);
      g.add(tyre);
    }
    const ramp = box(6, 0.4, 10.5, s * 26, 3.8, 0, yellow);   // raised ramps
    ramp.rotation.z = s * 0.55;
    g.add(ramp);
    const gantry = box(0.5, 6, 0.5, s * 22.5, 5.5, 4.8, yellow);   // lifting gantries
    const gantry2 = box(0.5, 6, 0.5, s * 22.5, 5.5, -4.8, yellow);
    const beam = box(0.5, 0.5, 10.1, s * 22.5, 8.3, 0, yellow);
    g.add(gantry, gantry2, beam);
  }
  const house = box(4.5, 3.4, 3.6, 3, 6, 4.2, white);         // offset wheelhouse on legs
  g.add(house);
  g.add(box(0.35, 2.2, 0.35, 1.5, 3.6, 3.2, white), box(0.35, 2.2, 0.35, 4.5, 3.6, 5.2, white));
  windows(4, 6.9, 6.05, g, 0.8);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 3.4, 6), white);
  mast.position.set(3, 9.2, 4.2); g.add(mast);
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

  addShip(cruiseFerry('viking'), ROUTES.viking, 9.0, 0.25, 1, false, 'viking');
  addShip(cruiseFerry('silja'), ROUTES.silja, 9.0, 0.7, -1, false, 'silja');
  addShip(roadFerry(), ROUTES.roadferry, 3.0, 0.4, 1, true, 'roadferry');  // a lossi never turns around
  addShip(connectionVessel(), ROUTES.utoline, 5.0, 0.55, 1, false, 'utoline');

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

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

// window band: a dark strip with warm emissive — reads as lit decks at dusk
function windows(len, y, z, g, h = 1.4) {
  const m = box(len, h, 0.4, 0, y, z, new THREE.MeshStandardMaterial({
    color: 0x1a2026, roughness: 0.4, emissive: 0xffc878, emissiveIntensity: 0.55,
  }));
  g.add(m);
}

// a Turku–Stockholm cruise ferry, ~160 m — unmistakable silhouette at distance
function cruiseFerry(scheme) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f3f0, roughness: 0.5 });
  const hullMat = new THREE.MeshStandardMaterial({
    color: scheme === 'viking' ? 0xc8271f : 0xf2f3f0, roughness: 0.55,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: scheme === 'viking' ? 0xc8271f : 0x1c4f9c, roughness: 0.5,
  });
  const L = 160, B = 26;
  const hull = box(L, 9, B, 0, 4.5, 0, hullMat);
  // raked bow
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.01, B / 2, 18, 4), hullMat);
  bow.rotation.z = -Math.PI / 2; bow.rotation.y = Math.PI / 4;
  bow.position.set(L / 2 + 7, 4.5, 0); bow.scale.y = 1;
  g.add(hull, bow);
  if (scheme === 'silja') g.add(box(L, 2.2, B + 0.2, 0, 4.2, 0, accent)); // blue waistband
  // superstructure decks
  g.add(box(L * 0.86, 7, B - 3, -4, 12.5, 0, white));
  g.add(box(L * 0.72, 6, B - 6, -8, 19, 0, white));
  g.add(box(L * 0.4, 4, B - 10, -14, 24, 0, white));
  windows(L * 0.8, 12.5, (B - 3) / 2 + 0.1, g); windows(L * 0.8, 12.5, -(B - 3) / 2 - 0.1, g);
  windows(L * 0.65, 19, (B - 6) / 2 + 0.1, g); windows(L * 0.65, 19, -(B - 6) / 2 - 0.1, g);
  // funnel
  const funnel = box(9, 8, 5, -L * 0.28, 28, 0, accent);
  funnel.rotation.z = 0.12;
  g.add(funnel);
  return g;
}

// a yellow double-ended road ferry (lossi): flat car deck, ramps both ends
function roadFerry() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c218, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf0f0ea, roughness: 0.55 });
  g.add(box(48, 2.6, 12, 0, 1.3, 0, yellow));
  g.add(box(46, 1.4, 0.5, 0, 3.3, 5.8, yellow));    // bulwarks
  g.add(box(46, 1.4, 0.5, 0, 3.3, -5.8, yellow));
  for (const s of [1, -1]) {                        // raised ramps
    const ramp = box(6, 0.4, 10.5, s * 26, 3.6, 0, yellow);
    ramp.rotation.z = s * 0.5;
    g.add(ramp);
  }
  const house = box(4.5, 3.6, 3.6, 3, 5.6, 4.0, white);   // offset wheelhouse
  g.add(house);
  windows(4, 6.4, 5.9, g, 0.8);
  return g;
}

// the small yellow archipelago connection vessel (the Utö line)
function connectionVessel() {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe8b414, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf0efe8, roughness: 0.5 });
  g.add(box(26, 3.2, 7, 0, 1.6, 0, yellow));
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 3.5, 6, 4), yellow);
  bow.rotation.z = -Math.PI / 2; bow.rotation.y = Math.PI / 4;
  bow.position.set(15.5, 1.6, 0);
  g.add(bow);
  g.add(box(12, 3, 5.4, -1, 4.7, 0, white));
  g.add(box(5, 2.4, 4.6, 2, 7.2, 0, white));
  windows(10, 4.9, 2.8, g, 0.8); windows(10, 4.9, -2.8, g, 0.8);
  return g;
}

export function createShips(scene) {
  const ships = [];

  function addShip(mesh, route, speed, startFrac, dir, fixedYaw = false, kind = '') {
    // arc-length table for steady motion along the polyline
    const seg = [];
    let total = 0;
    for (let i = 0; i < route.length - 1; i++) {
      const d = Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]);
      seg.push(d); total += d;
    }
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

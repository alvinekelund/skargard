import * as THREE from 'three';

/* Recognisable city landmarks, placed at their real coordinates so you know
   which city you're sailing into even when the surrounding blocks are only
   approximations. Global (always in the scene) — there are only a handful,
   and they're meant to be seen from far off.

   Projection (shared with every bake): x=(lon−21.49)·55997.6, z=−(lat−59.805)·111320. */
const K = 55997.6, M = 111320;
const ll = (lat, lon) => [(lon - 21.49) * K, -(lat - 59.805) * M];

function box(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// Helsinki Cathedral — Engel's white neoclassical church over Senate Square:
// a Greek cross with columned porticoes, a tall green dome on a colonnaded
// drum, four small green corner cupolas. The single most recognisable Helsinki
// silhouette.
function helsinkiCathedral() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.72 });
  const green = new THREE.MeshStandardMaterial({ color: 0x6f9484, roughness: 0.55, metalness: 0.1 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd9b45a, roughness: 0.4, metalness: 0.5 });
  const stone = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.85 });

  // podium / steps (the church stands high on a hill above the square)
  g.add(box(52, 12, 52, 0, -6, 0, stone));
  g.add(box(40, 3, 40, 0, 1.5, 0, white));

  // Greek-cross body: central block + four arms
  g.add(box(19, 17, 19, 0, 11.5, 0, white));
  for (const [dx, dz, w, d] of [[13, 0, 8, 13], [-13, 0, 8, 13], [0, 13, 13, 8], [0, -13, 13, 8]]) {
    g.add(box(w, 14, d, dx, 10, dz, white));
  }
  // columned porticoes with pediments on all four fronts
  const col = new THREE.CylinderGeometry(0.7, 0.7, 11, 8);
  for (const [ax, az, along] of [[0, 20, true], [0, -20, true], [20, 0, false], [-20, 0, false]]) {
    for (let i = -3; i <= 3; i++) {
      const c = new THREE.Mesh(col, white);
      c.position.set(ax + (along ? i * 2.6 : 0), 8.5, az + (along ? 0 : i * 2.6));
      g.add(c);
    }
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 5.2, 4, 3), white); // triangular pediment
    ped.rotation.y = along ? 0 : Math.PI / 2;
    ped.scale.set(along ? 4.0 : 1, 1, along ? 1 : 4.0);
    ped.position.set(ax, 16, az);
    g.add(ped);
  }

  // central drum (colonnade) + tall green dome + lantern + cross
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 12, 24), white);
  drum.position.y = 26; g.add(drum);
  const dcol = new THREE.CylinderGeometry(0.5, 0.5, 11, 6);
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    g.add(box(0.01, 0, 0.01, 0, 0, 0, white)); // noop keeps indices simple
    const c = new THREE.Mesh(dcol, white);
    c.position.set(Math.cos(a) * 8.9, 26, Math.sin(a) * 8.9);
    g.add(c);
  }
  const dome = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), green);
  dome.position.y = 32; dome.scale.y = 1.5; g.add(dome);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 6, 12), white);
  lantern.position.y = 47; g.add(lantern);
  const cupTop = new THREE.Mesh(new THREE.SphereGeometry(2.4, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), green);
  cupTop.position.y = 50; cupTop.scale.y = 1.3; g.add(cupTop);
  g.add(box(0.4, 4, 0.4, 0, 54, 0, gold)); g.add(box(2.4, 0.4, 0.4, 0, 54.5, 0, gold)); // gold cross

  // four green corner cupolas
  for (const [cx, cz] of [[9, 9], [-9, 9], [9, -9], [-9, -9]]) {
    const cd = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 5, 12), white);
    cd.position.set(cx, 20, cz); g.add(cd);
    const cdm = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), green);
    cdm.position.set(cx, 22.5, cz); cdm.scale.y = 1.4; g.add(cdm);
  }
  return g;
}

// Turku Cathedral — the red-brick medieval mother church on the Aura: a long
// high nave with a steep roof and, at the west end, the tall square tower with
// its green copper spire (~100 m, the tallest thing for miles).
function turkuCathedral() {
  const g = new THREE.Group();
  const brick = new THREE.MeshStandardMaterial({ color: 0x93503f, roughness: 0.9 });
  const brickD = new THREE.MeshStandardMaterial({ color: 0x7d4234, roughness: 0.9 });
  const green = new THREE.MeshStandardMaterial({ color: 0x6a9080, roughness: 0.55, metalness: 0.1 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd9b45a, roughness: 0.4, metalness: 0.5 });

  // nave (long body) + steep gable roof, apse at the east end
  g.add(box(16, 22, 46, 0, 11, 0, brick));
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 9.5, 8, 3), brickD);
  roof.scale.set(1, 1, 5.1); roof.rotation.x = Math.PI / 2; roof.rotation.z = Math.PI;
  roof.position.set(0, 26, 0); g.add(roof);
  const apse = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 20, 12, 1, false, -Math.PI / 2, Math.PI), brick);
  apse.position.set(0, 10, -23); g.add(apse);

  // the great west tower + tall pyramidal green spire + gold cross
  g.add(box(15, 46, 15, 0, 23, 27, brick));
  g.add(box(16.5, 5, 16.5, 0, 44, 27, brickD));           // corbel course
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 8.6, 40, 4), green);
  spire.rotation.y = Math.PI / 4; spire.position.set(0, 67, 27); g.add(spire);
  g.add(box(0.5, 6, 0.5, 0, 89, 27, gold)); g.add(box(3, 0.5, 0.5, 0, 90, 27, gold));
  // tall lancet window hints on the tower
  for (const s of [1, -1]) g.add(box(0.3, 12, 3, s * 7.6, 26, 27, brickD));
  return g;
}

// Uspenski Cathedral — the great red-brick Orthodox cathedral on the
// Katajanokka rock, right over the South Harbour: a mass of dark-red brick
// under gilded onion domes (one big central cupola on a tall drum, ringed by
// smaller ones) with green-copper tent roofs. Together with Engel's white
// cathedral it's what tells you, from the water, that this is Helsinki.
function uspenskiCathedral() {
  const g = new THREE.Group();
  const brick = new THREE.MeshStandardMaterial({ color: 0x8f4030, roughness: 0.9 });
  const brickD = new THREE.MeshStandardMaterial({ color: 0x743323, roughness: 0.9 });
  const green = new THREE.MeshStandardMaterial({ color: 0x5f8676, roughness: 0.5, metalness: 0.15 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xcaa03e, roughness: 0.35, metalness: 0.65 });
  const stone = new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.85 });

  g.add(box(30, 10, 30, 0, -4, 0, stone));                 // the rock podium it stands on
  g.add(box(21, 15, 21, 0, 8, 0, brick));                  // brick body
  // arched gables (kokoshnik) hinted as a lighter brick band under the roofline
  g.add(box(22, 2.4, 22, 0, 16, 0, brickD));
  // green tent roofs stepping up to the central drum
  const tent = (r, h, y, mat) => { const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 4), mat); m.rotation.y = Math.PI / 4; m.position.y = y; return m; };
  g.add(tent(15.5, 7, 20.5, green));

  // a gilded onion dome on a drum
  const onion = (R, y, drumH, drumR) => {
    const grp = new THREE.Group();
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(drumR, drumR, drumH, 12), brick);
    drum.position.y = y; grp.add(drum);
    // onion: a sphere pinched to a point on top
    const b = new THREE.Mesh(new THREE.SphereGeometry(R, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), gold);
    b.scale.y = 1.15; b.position.y = y + drumH / 2; grp.add(b);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(R * 0.5, R * 1.3, 12), gold);
    tip.position.y = y + drumH / 2 + R * 0.55; grp.add(tip);
    grp.add(box(0.3, 2.4, 0.3, 0, y + drumH / 2 + R * 1.15, 0, gold));   // cross staff
    grp.add(box(1.5, 0.3, 0.3, 0, y + drumH / 2 + R * 0.95, 0, gold));
    return grp;
  };
  g.add(onion(5.2, 26, 12, 4.2));                          // tall central cupola
  for (const [cx, cz] of [[8, 8], [-8, 8], [8, -8], [-8, -8]]) {
    const o = onion(2.1, 20, 5, 1.6); o.position.set(cx, 0, cz); g.add(o);   // four corner cupolas
  }
  return g;
}

// A medieval archipelago church (Nagu, Korpo…) — the landmark of every big
// parish island: a long greystone nave under a very steep black shingle roof,
// whitewashed gable tops, a slender ridge turret, and the separate low timber
// bell tower (klockstapel) beside it. From the sound it's the steep dark roof
// over the trees that tells you which village you're closing.
function parishChurch() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xa8a394, roughness: 0.95 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe6e2d4, roughness: 0.8 });
  const shingle = new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: 0.9 });
  const timber = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.9 });

  // nave: fieldstone walls, then the steep roof rising higher than the walls
  g.add(box(12, 7, 30, 0, 3.5, 0, stone));
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 8.6, 9, 3), shingle);
  roof.scale.set(1, 1, 3.7); roof.rotation.x = Math.PI / 2; roof.rotation.z = Math.PI;
  roof.position.set(0, 11.5, 0); g.add(roof);
  // slender ridge turret with a little spire and cross
  g.add(box(2.2, 3.4, 2.2, 0, 16.5, 9, timber));
  const tspire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 1.8, 4.4, 4), shingle);
  tspire.rotation.y = Math.PI / 4; tspire.position.set(0, 20.4, 9); g.add(tspire);
  g.add(box(0.18, 1.6, 0.18, 0, 23, 9, white)); g.add(box(0.9, 0.18, 0.18, 0, 23.3, 9, white));
  // the separate klockstapel: splayed timber base, open belfry, pyramid cap
  const bt = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 4.2, 8, 4), timber);
  base.rotation.y = Math.PI / 4; base.position.y = 4; bt.add(base);
  const belfry = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 3.4), timber);
  belfry.position.y = 9.2; bt.add(belfry);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 2.9, 3.6, 4), shingle);
  cap.rotation.y = Math.PI / 4; cap.position.y = 12.3; bt.add(cap);
  bt.position.set(13, 0, -11);
  g.add(bt);
  return g;
}

export function createLandmarks(scene) {
  const items = [
    { build: helsinkiCathedral, lat: 60.1697, lon: 24.9521, y: 7, yaw: 0 },
    { build: uspenskiCathedral, lat: 60.1683, lon: 24.9590, y: 6, yaw: 0.3 },
    { build: turkuCathedral, lat: 60.4525, lon: 22.2783, y: 8, yaw: 0.5 },
    // the parish churches of the big archipelago islands, at their real spots
    { build: parishChurch, lat: 60.1953, lon: 21.9106, y: 6, yaw: 0.25 },  // Nagu kyrka
    { build: parishChurch, lat: 60.1637, lon: 21.5750, y: 8, yaw: 1.85 },  // Korpo kyrka
  ];
  const group = new THREE.Group();
  for (const it of items) {
    const m = it.build();
    const [x, z] = ll(it.lat, it.lon);
    m.position.set(x, it.y, z);
    m.rotation.y = it.yaw;
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(m);
  }
  scene.add(group);
  return { group };
}

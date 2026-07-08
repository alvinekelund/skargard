import * as THREE from 'three';

/* Ambient summer traffic — the water is never empty out here in July.
   A player-following field of small craft that ACTUALLY sail: cruising sloops
   heeled to leeward with real triangular main + headsail on a valid point of
   sail, plus a few motor cruisers of Swan-comparable size (never dinghies).
   Boats live in a ring around the helm; when one drifts out of the streamed
   region — or would run onto rock — it respawns on open water somewhere else.
   Land avoidance and course-keeping use the same heightAt() the hull grounds
   on, so nobody sails through an island.

   Scale (brief #5/#6): sloops 9–12 m LOA, cruisers 8–11 m — comparable to the
   Swan 36 (11 m), not toys. Densest near the fairways; sparser in open water. */

const DEG = Math.PI / 180;

// bow points +Z (matches the world heading convention: fwd = (sin h, cos h),
// yaw = atan2(dx, dz)). Everything below is built in that frame.

// a canoe-bodied yacht hull, long axis along Z, pointed bow at +Z, reverse
// transom aft. Extruded from a waterline plan, then given a bit of sheer.
function yachtHull(L, B, freeboard, mat, bootMat) {
  const g = new THREE.Group();
  const s = new THREE.Shape();
  const bow = L * 0.5, stern = -L * 0.5, hb = B * 0.5;
  s.moveTo(0, bow);                                   // fine stem
  s.quadraticCurveTo(hb, bow - L * 0.28, hb, L * 0.02);
  s.quadraticCurveTo(hb, stern + L * 0.16, hb * 0.62, stern); // reverse transom corner
  s.lineTo(-hb * 0.62, stern);
  s.quadraticCurveTo(-hb, stern + L * 0.16, -hb, L * 0.02);
  s.quadraticCurveTo(-hb, bow - L * 0.28, 0, bow);
  const h = freeboard + 0.9;                          // topsides + a little draft shown
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);                          // extrude +Z(shape) → +Y up
  const hull = new THREE.Mesh(geo, mat);
  hull.position.y = -0.9;                             // sink the draft below the waterline
  g.add(hull);
  // dark boot stripe riding the waterline
  const boot = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.34, bevelEnabled: false }), bootMat);
  boot.geometry.rotateX(-Math.PI / 2);
  boot.scale.set(1.012, 1, 1.004);
  boot.position.y = -0.04;
  g.add(boot);
  return g;
}

const _white = new THREE.MeshStandardMaterial({ color: 0xeceae2, roughness: 0.62 });
const _teak = new THREE.MeshStandardMaterial({ color: 0xb08a4e, roughness: 0.8 });
const _dark = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.7 });
const _spar = new THREE.MeshStandardMaterial({ color: 0xd8d9d5, roughness: 0.35, metalness: 0.55 });
const _sailMat = new THREE.MeshStandardMaterial({
  color: 0xf3efe4, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
});
const _genoaMat = new THREE.MeshStandardMaterial({
  color: 0xefe9da, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide,
});
const HULL_COLORS = [0xece9e1, 0xe6e3db, 0x21324a, 0x0f4f57, 0x8f2d2a, 0x2b3a2c, 0xd8d4c6, 0x3a4657];

// A triangular sail (A = tack at foot of luff, B = head, C = clew) lofted as a
// small u,v grid with a sine belly pushed to leeward along the sail-plane
// normal. Coarse enough for many instances, fine enough to read as cloth.
function sailMesh(A, B, C, belly, draftSign, mat) {
  const R = 8, K = 8;
  const N = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)).normalize();
  const pos = new Float32Array((R + 1) * (K + 1) * 3);
  const L = new THREE.Vector3(), F = new THREE.Vector3(), P = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i <= R; i++) {
    const u = i / R;                                  // 0 foot → 1 head, along the luff
    L.lerpVectors(A, B, u);                           // luff point
    F.lerpVectors(C, B, u);                           // opposite edge (foot→leech collapses at head)
    for (let j = 0; j <= K; j++) {
      const v = j / K;                                // 0 luff → 1 leech
      P.lerpVectors(L, F, v);
      const bulge = belly * Math.sin(Math.PI * v) * Math.sin(Math.PI * (0.35 + 0.65 * (1 - u)));
      pos[n++] = P.x + N.x * bulge * draftSign;
      pos[n++] = P.y + N.y * bulge * draftSign;
      pos[n++] = P.z + N.z * bulge * draftSign;
    }
  }
  const idx = [];
  for (let i = 0; i < R; i++) for (let j = 0; j < K; j++) {
    const a = i * (K + 1) + j, b = a + 1, c = a + (K + 1), d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

// A cruising sloop: hull, low cabin trunk, cockpit, mast, boom, and a
// mainsail + headsail. The main+boom live in a group that pivots about the
// mast (sheet the main by rotating it); the jib pivots about the forestay.
function buildSloop(rng) {
  const L = 9 + rng() * 3.5;                          // 9–12.5 m LOA
  const B = L * 0.31;
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({
    color: HULL_COLORS[(rng() * HULL_COLORS.length) | 0], roughness: 0.5, metalness: 0.05,
  });
  g.add(yachtHull(L, B, 1.05, hullMat, _dark));

  // deck + low cabin trunk + cockpit coaming
  const deck = new THREE.Mesh(new THREE.BoxGeometry(B * 0.9, 0.08, L * 0.94), _white);
  deck.position.y = 0.16; g.add(deck);
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(B * 0.58, 0.5, L * 0.34), _white);
  trunk.position.set(0, 0.44, L * 0.06); g.add(trunk);
  const trunkTop = new THREE.Mesh(new THREE.BoxGeometry(B * 0.5, 0.06, L * 0.3), _teak);
  trunkTop.position.set(0, 0.7, L * 0.06); g.add(trunkTop);

  // lifelines: bow/stern pulpit stanchions + a thin rail (reads as safety rail)
  const railMat = _spar;
  for (const side of [1, -1]) {
    for (let k = 0; k < 5; k++) {
      const z = L * 0.4 - k * (L * 0.8 / 4);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 4), railMat);
      st.position.set(side * B * 0.45, 0.46, z); g.add(st);
    }
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, L * 0.82, 4), railMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(side * B * 0.45, 0.74, L * 0.0); g.add(rail);
  }

  const mastZ = L * 0.08, mastH = L * 1.42;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, mastH, 6), _spar);
  mast.position.set(0, mastH * 0.5, mastZ); g.add(mast);

  // main + boom pivot about the mast
  const mainGroup = new THREE.Group();
  mainGroup.position.set(0, 0, mastZ);
  const boomLen = L * 0.5;
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, boomLen, 6), _spar);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 1.35, -boomLen * 0.5); mainGroup.add(boom);
  const tack = new THREE.Vector3(0, 1.45, 0);
  const head = new THREE.Vector3(0, mastH * 0.96, 0);
  const clew = new THREE.Vector3(0, 1.32, -boomLen);
  const main = sailMesh(tack, head, clew, L * 0.05, 1, _sailMat);
  main.name = 'main';
  mainGroup.add(main);
  g.add(mainGroup);

  // headsail (genoa) tacked at the stemhead, pivots about the forestay
  const jibGroup = new THREE.Group();
  const stemZ = L * 0.46;
  jibGroup.position.set(0, 0, stemZ);
  const jTack = new THREE.Vector3(0, 0.6, 0);
  const jHead = new THREE.Vector3(0, mastH * 0.98, mastZ - stemZ);
  const jClew = new THREE.Vector3(0, 1.2, -(stemZ - mastZ) * 0.7 - L * 0.16);
  const jib = sailMesh(jTack, jHead, jClew, L * 0.045, 1, _genoaMat);
  jib.name = 'jib';
  jibGroup.add(jib);
  g.add(jibGroup);

  g.userData = { mainGroup, jibGroup, main, jib, L };
  return g;
}

// A motor cruiser (displacement / semi-planing) ~8–11 m: shaped hull, windscreen
// deckhouse, a short radar arch. No sails; cruises on a heading.
function buildCruiser(rng) {
  const L = 8 + rng() * 3;
  const B = L * 0.34;
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({
    color: rng() < 0.5 ? 0xeeece4 : HULL_COLORS[(rng() * HULL_COLORS.length) | 0], roughness: 0.5, metalness: 0.06,
  });
  g.add(yachtHull(L, B, 1.15, hullMat, _dark));
  const deck = new THREE.Mesh(new THREE.BoxGeometry(B * 0.92, 0.1, L * 0.92), _white);
  deck.position.y = 0.2; g.add(deck);
  // deckhouse forward, open cockpit aft
  const house = new THREE.Mesh(new THREE.BoxGeometry(B * 0.82, 1.15, L * 0.4), _white);
  house.position.set(0, 0.85, L * 0.12); g.add(house);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(B * 0.7, 0.5, L * 0.36), new THREE.MeshStandardMaterial({
    color: 0x1a2530, roughness: 0.2, metalness: 0.5, emissive: 0x223040, emissiveIntensity: 0.2,
  }));
  glass.position.set(0, 1.2, L * 0.12); g.add(glass);
  // windscreen rake
  const ws = new THREE.Mesh(new THREE.BoxGeometry(B * 0.72, 0.55, 0.06), glass.material);
  ws.position.set(0, 1.25, L * 0.32); ws.rotation.x = 0.5; g.add(ws);
  // radar arch
  for (const side of [1, -1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6), _spar);
    leg.position.set(side * B * 0.35, 1.4, -L * 0.06); leg.rotation.x = -0.12; g.add(leg);
  }
  const arch = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, B * 0.72, 6), _spar);
  arch.rotation.z = Math.PI / 2; arch.position.set(0, 2.05, -L * 0.09); g.add(arch);
  g.userData = { L };
  return g;
}

export function createFleet(scene, { heightAt }) {
  const group = new THREE.Group();
  group.name = 'fleet';
  scene.add(group);

  const rngState = { s: 20260708 >>> 0 };
  const rng = () => {
    let t = (rngState.s += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const SAIL_N = 11, MOTOR_N = 4;
  const boats = [];

  function makeBoat(kind) {
    const model = kind === 'sail' ? buildSloop(rng) : buildCruiser(rng);
    model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    const outer = new THREE.Group();     // yaw + position
    const inner = new THREE.Group();     // heel (roll) + pitch
    inner.add(model);
    outer.add(inner);
    group.add(outer);
    const b = {
      kind, outer, inner, model,
      x: 0, z: 0, heading: 0, targetHeading: 0, speed: 0,
      heel: 0, heelTarget: 0, pitch: 0, bobPhase: rng() * 6.28,
      recourse: 0, active: false, L: model.userData.L,
    };
    boats.push(b);
    return b;
  }
  for (let i = 0; i < SAIL_N; i++) makeBoat('sail');
  for (let i = 0; i < MOTOR_N; i++) makeBoat('motor');

  const isWater = (x, z) => heightAt(x, z) < -1.4;

  // pick a course that is a valid point of sail (never in the no-go zone) for a
  // sailboat; any heading for a motorboat.
  function pickCourse(b, windFrom) {
    if (b.kind === 'motor') return (rng() * 2 - 1) * Math.PI;
    const twa = (52 + rng() * 108) * DEG;             // 52°–160° off the wind
    const tack = rng() < 0.5 ? 1 : -1;
    return windFrom + tack * twa;
  }

  // find open water near the player and (re)place a boat there
  function respawn(b, px, pz, windFrom) {
    for (let tries = 0; tries < 16; tries++) {
      const bearing = rng() * Math.PI * 2;
      const dist = 420 + rng() * 980;                 // 420–1400 m out (inside the streamed ring)
      const x = px + Math.sin(bearing) * dist;
      const z = pz + Math.cos(bearing) * dist;
      // needs water at the spot and a little room around it
      if (!isWater(x, z)) continue;
      if (!isWater(x + 30, z) || !isWater(x - 30, z) || !isWater(x, z + 30) || !isWater(x, z - 30)) continue;
      b.x = x; b.z = z;
      b.heading = b.targetHeading = pickCourse(b, windFrom);
      b.speed = b.kind === 'motor' ? 5 + rng() * 3.5 : 2 + rng() * 2;
      b.recourse = 14 + rng() * 26;
      b.active = true;
      b.outer.visible = true;
      return true;
    }
    b.active = false;
    b.outer.visible = false;
    return false;
  }

  const _clampAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  function update(dt, t, { playerPos, windHeading, windSpeed, waveHeightAt }) {
    if (!playerPos) return;
    const px = playerPos.x, pz = playerPos.z;
    const windFrom = windHeading + Math.PI;           // heading the wind blows FROM

    for (const b of boats) {
      if (!b.active) { respawn(b, px, pz, windFrom); continue; }

      // out of the streamed region → recycle somewhere else
      const dx = b.x - px, dz = b.z - pz;
      if (dx * dx + dz * dz > 1550 * 1550) { respawn(b, px, pz, windFrom); continue; }

      // choose a fresh course now and then (varied traffic)
      b.recourse -= dt;
      if (b.recourse <= 0) { b.targetHeading = pickCourse(b, windFrom); b.recourse = 16 + rng() * 30; }

      // land avoidance: look ahead; if rock is coming, steer toward the more open
      // side. Overrides the target course until the way is clear again.
      const look = Math.max(45, b.speed * 12);
      const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
      const aheadLand = !isWater(b.x + fx * look, b.z + fz * look);
      if (aheadLand) {
        const lh = b.heading + 55 * DEG, rh = b.heading - 55 * DEG;
        const lClear = isWater(b.x + Math.sin(lh) * look, b.z + Math.cos(lh) * look);
        const rClear = isWater(b.x + Math.sin(rh) * look, b.z + Math.cos(rh) * look);
        b.targetHeading = lClear ? lh : rClear ? rh : b.heading + Math.PI; // both blocked → turn back
      }

      // steer toward target (boats turn gently)
      let d = _clampAngle(b.targetHeading - b.heading);
      b.heading += d * (1 - Math.exp(-0.9 * dt));

      // sailboats slow in the no-go zone and near land; motorboats hold speed
      let spd = b.speed;
      if (b.kind === 'sail') {
        const twa = Math.abs(_clampAngle(b.heading - windFrom));   // 0 = head to wind
        const drive = Math.sin(Math.min(twa, Math.PI - twa * 0.15)); // weak upwind, full on a reach
        spd = b.speed * (0.35 + 0.65 * Math.max(0, drive)) * (0.7 + 0.5 * windSpeed);
        // Heel + sail trim, BOTH to leeward (same side — a boat heels away from
        // the wind and its sails are eased to that same downwind side). Wind on
        // the port bow (heading CW of where it blows from) → heels + trims to
        // starboard, and vice-versa. rotation.z (heel) and rotation.y (boom
        // swing) share the sign so the rig never ends up aback.
        const lee = _clampAngle(b.heading - windFrom) > 0 ? 1 : -1; // leeward side
        b.heelTarget = lee * Math.min(0.34, 0.05 + 0.5 * windSpeed * Math.sin(twa));
        const boomA = (12 + 68 * Math.min(1, (twa - 45 * DEG) / (135 * DEG))) * DEG;
        const ud = b.model.userData;
        ud.mainGroup.rotation.y = lee * boomA;
        ud.jibGroup.rotation.y = lee * boomA * 0.7;
      }
      // clamp aground → recycle (shouldn't happen, but be safe)
      if (!isWater(b.x, b.z)) { respawn(b, px, pz, windFrom); continue; }

      b.x += Math.sin(b.heading) * spd * dt;
      b.z += Math.cos(b.heading) * spd * dt;

      // pose
      const bob = waveHeightAt ? waveHeightAt(b.x, b.z, t) : 0;
      b.outer.position.set(b.x, bob, b.z);
      b.outer.rotation.y = b.heading;
      b.heel += (b.heelTarget - b.heel) * (1 - Math.exp(-1.4 * dt));
      b.inner.rotation.z = b.heel;
      b.inner.rotation.x = Math.sin(t * 0.7 + b.bobPhase) * 0.02;
    }
  }

  return { group, update };
}

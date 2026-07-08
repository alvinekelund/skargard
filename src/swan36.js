// ============================================================================
// Nautor Swan 36 (S&S design #1710, 1967) — fully procedural Three.js model.
// No external assets. Units: metres.
// Axes: +X = forward (bow), +Y = up, +Z = starboard.
// The design waterline (DWL) is the plane y = 0 — add the group to your scene
// at sea level and it floats on its lines. LOA 10.97, LWL ~7.6, beam 2.87,
// draft 1.80, long overhangs, low trunk, fin keel + spade rudder, masthead sloop.
//
//   import { buildSwan36 } from './swan36.js';
//   const boat = buildSwan36({ withSails: true });
//   scene.add(boat);
// ============================================================================
import * as THREE from 'three';

// shared flutter uniforms — boat.js drives these once per frame; the sails flog
// in the shader (three incommensurate sines, amplitude growing toward the leech)
export const sailUniforms = { uTime: { value: 0 }, uFlap: { value: 0 } };

function makeSailMaterial(phase = 0) {
  const m = new THREE.MeshStandardMaterial({ color: 0xf2eee2, roughness: 0.9, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = sailUniforms.uTime;
    sh.uniforms.uFlap = sailUniforms.uFlap;
    sh.uniforms.uPhase = { value: phase };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime, uFlap, uPhase;
        attribute vec2 aSail;                       // x: 0 luff → 1 leech · y: 0 foot → 1 head
        float flogW(vec2 s, float t) {              // ≈ cloth flog, 3–7.5 Hz
          return sin(19.0*t + 9.0*s.x + 5.0*s.y)
               + 0.55*sin(31.0*t + 14.0*s.x + 2.7*s.y)
               + 0.30*sin(47.0*t - 7.0*s.x);
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        { float e0 = smoothstep(0.12, 1.0, aSail.x); // lighting shimmer, no CPU normals
          objectNormal.z += uFlap * 0.6 * e0 * cos(19.0*(uTime+uPhase) + 9.0*aSail.x + 5.0*aSail.y);
          objectNormal = normalize(objectNormal); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { float t = uTime + uPhase;
          float edge = smoothstep(0.12, 1.0, aSail.x);   // amplitude grows toward the leech
          float span = 1.0 - 0.65 * aSail.y;             // calmer toward the head
          transformed.z += uFlap * 0.28 * edge * span * flogW(aSail, t);
          transformed.x -= uFlap * 0.05 * edge * sin(23.0*t + 6.0*aSail.y); }`);
  };
  return m;
}

export function buildSwan36({ withSails = true } = {}) {

  // --------------------------------------------------------------------------
  // 1. STATION TABLE — the naval-architecture core. 10 stations stem→transom.
  //    x        : longitudinal position (stem +5.49 … transom −5.48)
  //    sheerY   : height of deck edge (sheer) above DWL
  //    sheerHB  : half-beam at the sheer
  //    bilgeHB/Y: control point at the turn of the bilge
  //    keelY    : canoe-body depth at centreline (fin keel is separate)
  //  Sweeping S&S sheer: 1.05 m freeboard at stem, min 0.75 near st.6,
  //  rising to 0.86 at the transom. Long overhangs: hull leaves the water
  //  near x≈+3.9 and re-enters the counter around x≈−3.9 (LWL ≈ 7.6 m).
  // --------------------------------------------------------------------------
  const ST = [
    { x:  5.49, sheerY: 1.05, sheerHB: 0.00,  bilgeHB: 0.00, bilgeY:  0.62, keelY:  0.45 }, // stem head
    { x:  4.30, sheerY: 0.98, sheerHB: 0.44,  bilgeHB: 0.30, bilgeY:  0.12, keelY:  0.04 }, // fwd overhang
    { x:  3.10, sheerY: 0.92, sheerHB: 0.80,  bilgeHB: 0.60, bilgeY: -0.12, keelY: -0.30 }, // entry
    { x:  1.90, sheerY: 0.86, sheerHB: 1.12,  bilgeHB: 0.90, bilgeY: -0.26, keelY: -0.54 },
    { x:  0.60, sheerY: 0.80, sheerHB: 1.34,  bilgeHB: 1.08, bilgeY: -0.33, keelY: -0.64 },
    { x: -0.70, sheerY: 0.76, sheerHB: 1.435, bilgeHB: 1.17, bilgeY: -0.34, keelY: -0.66 }, // max beam (2.87)+depth
    { x: -1.90, sheerY: 0.75, sheerHB: 1.36,  bilgeHB: 1.10, bilgeY: -0.30, keelY: -0.55 }, // min freeboard
    { x: -3.20, sheerY: 0.78, sheerHB: 1.14,  bilgeHB: 0.90, bilgeY: -0.14, keelY: -0.27 },
    { x: -4.40, sheerY: 0.82, sheerHB: 0.86,  bilgeHB: 0.66, bilgeY:  0.06, keelY:  0.00 }, // counter
    { x: -5.48, sheerY: 0.86, sheerHB: 0.55,  bilgeHB: 0.42, bilgeY:  0.30, keelY:  0.26 }, // transom (above water)
  ];

  const g = new THREE.Group();
  g.name = 'swan36';
  g.userData = { LOA: 10.97, LWL: 7.6, beam: 2.87, draft: 1.8, waterlineY: 0 };

  // ------------------------------------------------------------- materials --
  const MAT = {
    hull: bandedHullMaterial(),                                                    // gelcoat/boot/antifoul
    deck: new THREE.MeshStandardMaterial({ color: 0xb9895a, roughness: 0.85 }),    // teak
    trim: new THREE.MeshStandardMaterial({ color: 0x7d5a33, roughness: 0.80 }),    // varnished teak
    gel:  new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.35 }),    // white gelcoat
    spar: new THREE.MeshStandardMaterial({ color: 0xb9bdc1, metalness: 0.75, roughness: 0.35 }), // anodised alu
    rig:  new THREE.MeshBasicMaterial({ color: 0x30363d }),                        // wire
    sail: new THREE.MeshStandardMaterial({ color: 0xf2eee2, roughness: 0.9, side: THREE.DoubleSide }),
  };

  // White topsides with navy boot stripe + dark-red antifouling, banded in the
  // fragment shader on hull-local Y so the paint stays crisp at any tessellation
  // and stays "painted on" when the boat heels.
  function bandedHullMaterial() {
    const m = new THREE.MeshStandardMaterial({ color: 0xf4f1e8, roughness: 0.35 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vHullY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHullY = position.y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHullY;')
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          'vec3 antifoul = vec3(0.20, 0.020, 0.014);',  // linear ~ sRGB #7b2a20
          'vec3 boot     = vec3(0.010, 0.028, 0.090);', // linear ~ sRGB #1c2f55
          'if (vHullY < 0.03) diffuseColor.rgb = antifoul;',
          'else if (vHullY < 0.16) diffuseColor.rgb = boot;',
        ].join('\n'));
    };
    return m;
  }

  // ------------------------------------------------------- lofting helpers --
  // One transverse section: Catmull-Rom through keel → garboard → turn of
  // bilge → sheer, sampled to N points (starboard half, keel first).
  const N = 12;
  function sectionPoints(s) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(s.x, s.keelY, 0),
      new THREE.Vector3(s.x, s.keelY + (s.bilgeY - s.keelY) * 0.30, s.bilgeHB * 0.55),
      new THREE.Vector3(s.x, s.bilgeY, s.bilgeHB),
      new THREE.Vector3(s.x, s.sheerY, s.sheerHB),
    ], false, 'catmullrom', 0.5);
    return curve.getPoints(N - 1); // N points keel→sheer
  }

  // Full ring: port sheer → keel → starboard sheer (2N-1 points, keel shared).
  const stationRings = ST.map((s) => {
    const stbd = sectionPoints(s);
    const ring = [];
    for (let j = N - 1; j >= 1; j--) ring.push(new THREE.Vector3(stbd[j].x, stbd[j].y, -stbd[j].z));
    for (const p of stbd) ring.push(p.clone());
    return ring;
  });

  // Proper loft: fair longitudinal splines THROUGH the station rings, then
  // resample so the surface is smooth between stations (this is the "battens
  // over moulds" step of real lofting).
  function refineRings(rings, count) {
    const rows = rings[0].length;
    const longs = [];
    for (let j = 0; j < rows; j++) {
      longs.push(new THREE.CatmullRomCurve3(rings.map((r) => r[j]), false, 'catmullrom', 0.5));
    }
    const out = [];
    for (let i = 0; i <= count; i++) out.push(longs.map((c) => c.getPoint(i / count)));
    return out;
  }

  // Skin a list of rings into an indexed BufferGeometry (+optional end cap fan).
  // Winding assumes rings run bow→stern (or root→tip) and points run
  // port→starboard (or around a foil); flip=true inverts for up-facing decks.
  function loftRings(rings, { capEnd = false, flip = false } = {}) {
    const rows = rings[0].length;
    const pos = [];
    for (const ring of rings) for (const p of ring) pos.push(p.x, p.y, p.z);
    const idx = [];
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < rows - 1; j++) {
        const a = i * rows + j, b = (i + 1) * rows + j;
        if (flip) idx.push(a, b, a + 1, a + 1, b, b + 1);
        else idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    if (capEnd) { // triangle fan over the last ring (transom / foil tip)
      const last = rings[rings.length - 1];
      const c = new THREE.Vector3();
      for (const p of last) c.add(p);
      c.divideScalar(last.length);
      const ci = pos.length / 3;
      pos.push(c.x, c.y, c.z);
      const base = (rings.length - 1) * rows;
      for (let j = 0; j < rows - 1; j++) idx.push(ci, base + j, base + j + 1);
      // close the chord between the ring's two ends — the transom ring is an
      // OPEN arc (sheer→keel→sheer), and without this triangle the whole top
      // of the transom is a hole (degenerate & harmless on closed foil rings)
      idx.push(ci, base + rows - 1, base);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // ------------------------------------------------------------------ hull --
  // Stem ring has zero beam, so the bow closes itself; transom gets a cap fan;
  // the open sheer line is covered by the deck → watertight envelope.
  const hull = new THREE.Mesh(loftRings(refineRings(stationRings, 48), { capEnd: true }), MAT.hull);
  hull.name = 'hull';

  // ------------------------------------------------------------------ deck --
  // Deck follows the sheer with ~0.06 m camber (crown), faded to zero at both
  // ends so the edges land exactly on the sheer. The cockpit well is a grid
  // depression — no CSG needed.
  const sheerCurve = new THREE.CatmullRomCurve3(
    ST.map((s) => new THREE.Vector3(s.x, s.sheerY, s.sheerHB)));
  const DM = 72, DK = 16, CROWN = 0.06;
  const COCKPIT = { x0: -3.35, x1: -1.55, hw: 0.60, depth: 0.35 };
  const deckRings = [];
  for (let i = 0; i <= DM; i++) {
    const q = sheerCurve.getPoint(i / DM);         // q.x = x, q.y = sheer, q.z = half-beam
    const hb = Math.max(q.z, 1e-4);
    const fade = Math.max(0, Math.min(1, (5.49 - q.x) / 1.2, (q.x + 5.48) / 1.2));
    const row = [];
    for (let j = 0; j <= DK; j++) {
      const z = -hb + (2 * hb * j) / DK;
      let y = q.y + CROWN * fade * (1 - (z / hb) ** 2);
      if (q.x > COCKPIT.x0 && q.x < COCKPIT.x1 && Math.abs(z) < COCKPIT.hw) y -= COCKPIT.depth;
      row.push(new THREE.Vector3(q.x, y, z));
    }
    deckRings.push(row);
  }
  const deck = new THREE.Mesh(loftRings(deckRings, { flip: true }), MAT.deck);
  deck.name = 'deck';

  // --------------------------------------------------------------- toerail --
  // Slim varnished rail riding the sheer, hides the hull/deck seam.
  const railPts = [];
  for (const s of ST) railPts.push(new THREE.Vector3(s.x, s.sheerY + 0.015, s.sheerHB));
  for (let i = ST.length - 1; i >= 1; i--) railPts.push(new THREE.Vector3(ST[i].x, ST[i].sheerY + 0.015, -ST[i].sheerHB));
  const toerail = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts, true, 'catmullrom', 0.5), 240, 0.035, 5, true),
    MAT.trim);
  toerail.name = 'toerail';

  // ------------------------------------------------------------ cabin trunk --
  // Low, sleek S&S trunk: 3.6 m long, only ~0.42 m high, tapering in plan,
  // soft edges from the extrude bevel. Sits x −1.25 … +2.35.
  const cs = new THREE.Shape();                    // shape (x, y) → world (x, −z)
  const xa = -1.25, xf = 2.35, wa = 0.95, wf = 0.55, r = 0.55;
  const CWAY = { w: 0.30, d: 0.55 };               // companionway notch: half-width, depth fwd
  cs.moveTo(xa, -wa);
  cs.lineTo(xf - r, -wf);
  cs.quadraticCurveTo(xf, -wf, xf, 0);
  cs.quadraticCurveTo(xf, wf, xf - r, wf);
  cs.lineTo(xa, wa);
  // the companionway: a full-height notch in the aft face — with the sliding
  // hatch run back this IS what an open Swan companionway looks like
  cs.lineTo(xa, CWAY.w);
  cs.lineTo(xa + CWAY.d, CWAY.w);
  cs.lineTo(xa + CWAY.d, -CWAY.w);
  cs.lineTo(xa, -CWAY.w);
  cs.lineTo(xa, -wa);
  const cabinGeo = new THREE.ExtrudeGeometry(cs, {
    depth: 0.30, bevelEnabled: true, bevelThickness: 0.10, bevelSize: 0.08, bevelSegments: 3,
  });
  cabinGeo.rotateX(-Math.PI / 2);                  // extrude direction → +Y (up)
  const cabin = new THREE.Mesh(cabinGeo, MAT.gel);
  cabin.position.y = 0.92;                         // lower bevel buried in deck
  cabin.name = 'cabinTrunk';

  // --------------------------------------------------------------- coaming --
  // Teak coamings around the cockpit well, ~0.18 m proud of the deck.
  function slab(w, h, d, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), MAT.trim);
    m.position.set(x, y, z);
    return m;
  }
  const coaming = new THREE.Group();
  coaming.name = 'coaming';
  coaming.add(
    slab(1.95, 0.24, 0.035, -2.45, 0.88,  0.64),
    slab(1.95, 0.24, 0.035, -2.45, 0.88, -0.64),
    slab(0.035, 0.24, 1.31, -3.38, 0.88,  0),
  );

  // ------------------------------------------------------- keel and rudder --
  // NACA-ish 4-digit thickness form, lofted root→tip with sweep and taper.
  function foilRing(xLE, y, chord, t, n = 12) {
    const ring = [];
    const half = [];
    for (let i = 0; i <= n; i++) {
      const xc = i / n;
      const th = chord * 5 * t * (0.2969 * Math.sqrt(xc) - 0.1260 * xc
        - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
      half.push([xc * chord, Math.max(th, 0)]);
    }
    for (let i = 0; i <= n; i++) ring.push(new THREE.Vector3(xLE - half[i][0], y,  half[i][1]));
    for (let i = n; i >= 0; i--) ring.push(new THREE.Vector3(xLE - half[i][0], y, -half[i][1]));
    return ring;
  }
  // Fin keel: root buried in the canoe body, tip at full 1.80 m draft, swept.
  const keel = new THREE.Mesh(loftRings([
    foilRing(0.55, -0.45, 1.75, 0.12),
    foilRing(0.05, -1.80, 1.05, 0.10),
  ], { capEnd: true }), MAT.hull);
  keel.name = 'keel';
  // Spade rudder tucked under the counter.
  const rudder = new THREE.Mesh(loftRings([
    foilRing(-3.30, -0.10, 0.62, 0.11),
    foilRing(-3.62, -1.45, 0.34, 0.09),
  ], { capEnd: true }), MAT.hull);
  rudder.name = 'rudder';

  // ------------------------------------------------------------------- rig --
  // Masthead sloop. Mast 13.7 m above deck at x = +1.60 (J = 3.75 to stem),
  // boom 3.5 m (E ≈ 3.45), single spreaders, fore/back stays + cap shrouds.
  function spar(p1, p2, r1, r2, mat, seg = 10) {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const len = dir.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r1, len, seg), mat);
    mesh.position.copy(p1).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  }
  const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);
  const rigGroup = new THREE.Group();
  rigGroup.name = 'rig';
  const mast = spar(V(1.60, 0.92), V(1.60, 14.62), 0.075, 0.050, MAT.spar); // 13.7 m above deck
  mast.name = 'mast';
  const boom = spar(V(1.62, 2.07), V(-1.88, 2.07), 0.055, 0.055, MAT.spar); // 3.5 m
  boom.name = 'boom';
  rigGroup.add(
    mast, boom,
    spar(V(1.60, 7.00), V(1.60, 7.06,  0.86), 0.020, 0.014, MAT.spar, 6), // spreaders
    spar(V(1.60, 7.00), V(1.60, 7.06, -0.86), 0.020, 0.014, MAT.spar, 6),
    spar(V(1.60, 14.55), V(5.38, 1.08), 0.012, 0.012, MAT.rig, 5),        // forestay
    spar(V(1.60, 14.55), V(-5.40, 0.92), 0.012, 0.012, MAT.rig, 5),       // backstay
    spar(V(1.60, 14.50), V(1.60, 0.88,  1.14), 0.010, 0.010, MAT.rig, 5), // cap shrouds
    spar(V(1.60, 14.50), V(1.60, 0.88, -1.14), 0.010, 0.010, MAT.rig, 5),
  );

  // ----------------------------------------------------------------- sails --
  // Main: P ≈ 12.2, E ≈ 3.45, gentle roach. Genoa ~130%: tack at the stem
  // head, clew well aft of the mast. Sails are lofted as a luff→leech grid
  // (straight luff, quadratic-bezier leech) with a sine belly so they read as
  // cloth, not cardboard. All points given as (x, y) in the centreline plane.
  const V2 = (x, y) => new THREE.Vector2(x, y);
  function sailMesh(tack, head, clew, leechCtrl, belly, phase = 0) {
    const R = 16, K = 10;
    const leech = new THREE.QuadraticBezierCurve(clew, leechCtrl, head);
    const rings = [];
    for (let i = 0; i <= R; i++) {
      const v = i / R;                                 // 0 = foot, 1 = head
      const L = new THREE.Vector2().lerpVectors(tack, head, v);
      const E = leech.getPoint(v);
      const row = [];
      for (let j = 0; j <= K; j++) {
        const u = j / K;                               // 0 = luff, 1 = leech
        row.push(new THREE.Vector3(
          L.x + (E.x - L.x) * u,
          L.y + (E.y - L.y) * u,
          belly * Math.sin(Math.PI * u) * (1 - 0.85 * v),
        ));
      }
      rings.push(row);
    }
    const geo = loftRings(rings);
    // tag each vertex with (luff→leech, foot→head) for the flutter shader
    const sailUV = new Float32Array((R + 1) * (K + 1) * 2);
    let n = 0;
    for (let i = 0; i <= R; i++) for (let j = 0; j <= K; j++) { sailUV[n++] = j / K; sailUV[n++] = i / R; }
    geo.setAttribute('aSail', new THREE.BufferAttribute(sailUV, 2));
    return new THREE.Mesh(geo, makeSailMaterial(phase));
  }
  const sails = new THREE.Group();
  sails.name = 'sails';
  if (withSails) {
    const main = sailMesh(V2(1.66, 2.14), V2(1.66, 14.30),   // tack, head on mast
                          V2(-1.78, 2.14), V2(-0.90, 8.50),  // clew at boom end, roached leech
                          0.40, 0.0);                        // ~11% draft — a powered-up reaching belly
    main.name = 'mainsail';
    const jib = sailMesh(V2(5.30, 1.18), V2(1.70, 14.40),    // tack at stem, head at masthead
                         V2(0.55, 1.55), V2(1.45, 8.10),     // clew, slightly hollow leech
                         0.50, 1.7);                         // ~12% draft, de-synced flog phase
    jib.name = 'genoa';
    sails.add(main, jib);
  }

  // ------------------------------------------------------------- assemble --
  for (const mesh of [hull, deck, toerail, cabin, keel, rudder]) {
    mesh.castShadow = mesh.receiveShadow = true;
  }
  g.add(hull, deck, toerail, cabin, coaming, keel, rudder, rigGroup, sails);
  return g;
}
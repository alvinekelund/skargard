// ============================================================================
// src/swan36-detail.js — cockpit/deck/rig beauty pass for the procedural Swan 36.
// ~20 extra meshes (InstancedMesh + mergeGeometries). No external assets:
// two canvas textures (teak, dacron) + a PMREM env baked from a throwaway Sky.
//
// Integration (3 edits):
//   boat.js : import { detailSwan36 } from './swan36-detail.js';
//             const swan = buildSwan36({ withSails: true });
//             detailSwan36(swan);                                   // ← add
//             for (const name of ['boom','mainsail','boomGear']) {  // ← extend
//   main.js : import { bakeSkyEnvironment, applyBoatEnv } from './swan36-detail.js';
//             const envTex = bakeSkyEnvironment(renderer, { elev: 17, az: 150 });
//             applyBoatEnv(boat.group, envTex);   // after createBoat(...)
//             // on the T preset toggle re-bake with { elev: 5, az: 162, turbidity: 6 }
//
// Axes as swan36.js: +X fwd, +Y up, +Z stbd, y = 0 at DWL. All dims metres.
// ============================================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (x, y, z = 0) => new THREE.Vector3(x, y, z);

/* ---- env: PMREM from a throwaway Sky; boat-only IBL (no global changes) --- */
export function bakeSkyEnvironment(renderer,
  { elev = 17, az = 150, turbidity = 2.4, rayleigh = 3.0, mie = 0.005, g = 0.8 } = {}) {
  const sky = new Sky(); sky.scale.setScalar(900);
  const u = sky.material.uniforms;
  u.turbidity.value = turbidity; u.rayleigh.value = rayleigh;
  u.mieCoefficient.value = mie;  u.mieDirectionalG.value = g;
  u.sunPosition.value.setFromSphericalCoords(
    1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(az));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tmp = new THREE.Scene(); tmp.add(sky);
  const tex = pmrem.fromScene(tmp, 0, 1, 1000).texture;
  pmrem.dispose(); sky.geometry.dispose(); sky.material.dispose();
  return tex;
}
export function applyBoatEnv(root, tex) {
  root.traverse((o) => {
    if (o.isMesh && o.material && 'envMap' in o.material) {
      o.material.envMap = tex; o.material.needsUpdate = true;
    }
  });
}

/* ------------------------------ canvas textures --------------------------- */
function teakTexture(anisotropy = 8) {
  const W = 256, H = 1024, PL = 6, PW = W / PL;      // 6 planks/tile, 45 mm each
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  for (let p = 0; p < PL; p++) {
    const l = 48 + Math.random() * 10;                            // per-plank tone
    x.fillStyle = `hsl(33, 36%, ${l}%)`;
    x.fillRect(p * PW, 0, PW, H);
    for (let s = 0; s < 26; s++) {                                // grain streaks
      x.strokeStyle = `hsla(${28 + Math.random() * 12}, 34%, ${l - 12 - Math.random() * 10}%, 0.25)`;
      x.lineWidth = 0.8 + Math.random() * 1.4;
      const gx = p * PW + 3 + Math.random() * (PW - 6);
      const y0 = Math.random() * H, len = 80 + Math.random() * 320;
      x.beginPath(); x.moveTo(gx, y0);
      x.bezierCurveTo(gx + 3, y0 + len * 0.3, gx - 3, y0 + len * 0.7, gx + 1, y0 + len);
      x.stroke();
    }
    x.fillStyle = '#26231d';                                      // caulk seam
    x.fillRect(p * PW - 1.5, 0, 3, H);
    x.fillRect(p * PW, (p * 383) % H, PW, 3);                     // staggered butt
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}
function sailTexture(anisotropy = 8) {
  const W = 512, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#d6d0c2'; x.fillRect(0, 0, W, H);   // peak sRGB 0.839 → no bloom
  x.fillStyle = 'rgba(120,110,90,0.05)';             // cloth mottle
  for (let i = 0; i < 500; i++) x.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  x.fillStyle = '#cbc4b3';                           // tablings (luff/leech bands)
  x.fillRect(0, 0, 8, H); x.fillRect(W - 8, 0, 8, H);
  for (let i = 1; i <= 4; i++) {                     // 4 seams parallel to leech
    const sx = (i * W) / 5;                          // (u = luff→leech, so vertical)
    x.fillStyle = '#c3bcab'; x.fillRect(sx - 1, 0, 2.5, H);
    x.fillStyle = 'rgba(140,130,110,0.35)';          // stitch rows either side
    x.fillRect(sx - 5, 0, 1, H); x.fillRect(sx + 4, 0, 1, H);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

/* -------------------------------- uv helpers ------------------------------ */
function planarUVxz(geo) {                            // deck: u across, v fore-aft
  const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[2 * i] = (p.getZ(i) + 1.5) / 3.0;
    uv[2 * i + 1] = (p.getX(i) + 5.5) / 11.0;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}
function gridUV(geo, cols) {                          // sails: ring-major grid
  const n = geo.attributes.position.count, rows = n / cols;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[2 * i] = (i % cols) / (cols - 1);              // u: luff → leech
    uv[2 * i + 1] = Math.floor(i / cols) / (rows - 1);// v: foot → head
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/* ------------------------------ geometry helpers -------------------------- */
function barGeo(p1, p2, r, seg = 8) {                 // oriented cylinder as geometry
  const d = new THREE.Vector3().subVectors(p2, p1), len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.applyQuaternion(new THREE.Quaternion()
    .setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, (p1.z + p2.z) / 2);
  return g;
}
function boxGeo(w, h, d, x, y, z, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
function tubeGeo(pts, r, seg = 32, radial = 6) {
  return new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5), seg, r, radial, false);
}

/* ------------------------------- the beauty pass -------------------------- */
export function detailSwan36(swan, renderer = null) {
  const anis = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;

  // ---- materials -----------------------------------------------------------
  const SS     = new THREE.MeshStandardMaterial({ color: 0xdfe4e8, metalness: 1.0, roughness: 0.20, envMapIntensity: 1.25 });
  const CHROME = new THREE.MeshStandardMaterial({ color: 0xf0f3f5, metalness: 1.0, roughness: 0.10, envMapIntensity: 1.4 });
  const WIRE   = new THREE.MeshStandardMaterial({ color: 0xaeb4ba, metalness: 1.0, roughness: 0.35, envMapIntensity: 1.0 });
  const ROPE   = new THREE.MeshStandardMaterial({ color: 0xcfc6ae, roughness: 0.95 });
  const VARN   = new THREE.MeshPhysicalMaterial({ color: 0x7a5230, roughness: 0.26, clearcoat: 0.9, clearcoatRoughness: 0.18, envMapIntensity: 0.5 });
  const SMOKE  = new THREE.MeshPhysicalMaterial({ color: 0x14181d, roughness: 0.06, clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.0 });

  // ---- upgrade existing surfaces -------------------------------------------
  const gel = (rough) => new THREE.MeshPhysicalMaterial({
    color: 0xf2efe4, roughness: rough,
    clearcoat: 0.55, clearcoatRoughness: 0.22, envMapIntensity: 0.6,
  });
  const hullMat = gel(0.30);                          // keep boot-stripe bands
  hullMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vHullY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHullY = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHullY;')
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'vec3 antifoul = vec3(0.20, 0.020, 0.014);',
        'vec3 boot     = vec3(0.010, 0.028, 0.090);',
        'if (vHullY < 0.03) diffuseColor.rgb = antifoul;',
        'else if (vHullY < 0.16) diffuseColor.rgb = boot;',
      ].join('\n'));
  };
  for (const n of ['hull', 'keel', 'rudder']) swan.getObjectByName(n).material = hullMat;
  swan.getObjectByName('cabinTrunk').material = gel(0.34);

  const deck = swan.getObjectByName('deck');
  planarUVxz(deck.geometry);
  const teak = teakTexture(anis);
  teak.repeat.set(11, 4.2);                           // → 45 mm planks
  deck.material = new THREE.MeshStandardMaterial({ map: teak, roughness: 0.82, envMapIntensity: 0.2 });

  swan.getObjectByName('toerail').material = VARN;
  swan.getObjectByName('coaming').traverse((o) => { if (o.isMesh) o.material = VARN; });
  swan.getObjectByName('mast').material.envMapIntensity = 0.9;   // shared spar mat

  const dacron = sailTexture(anis);
  const sailMat = new THREE.MeshStandardMaterial({
    map: dacron, roughness: 0.72, side: THREE.DoubleSide, envMapIntensity: 0.25,
  });
  for (const n of ['mainsail', 'genoa']) {
    const s = swan.getObjectByName(n);
    if (s) { gridUV(s.geometry, 11); s.material = sailMat; }     // grid is 17×11
  }
  swan.getObjectByName('rig').traverse((o) => {                   // stays → wire
    if (o.isMesh && o.material.isMeshBasicMaterial) o.material = WIRE;
  });

  // ---- hardware -------------------------------------------------------------
  const H = new THREE.Group(); H.name = 'hardware';
  const noShadow = [];

  // 1. tiller + rudder head — Swan 36 is tiller-steered
  const tiller = new THREE.Mesh(tubeGeo(
    [V(-3.44, 0.90), V(-3.28, 1.08), V(-2.90, 1.10), V(-2.42, 0.96)], 0.020, 24, 8), VARN);

  // 2. winches — 2 chrome drums on the coaming tops (one InstancedMesh)
  const winchGeo = new THREE.LatheGeometry([
    [0.082, 0.000], [0.082, 0.014], [0.060, 0.022], [0.055, 0.060], [0.060, 0.100],
    [0.072, 0.118], [0.072, 0.132], [0.048, 0.140], [0.030, 0.146], [0.000, 0.150],
  ].map((p) => new THREE.Vector2(p[0], p[1])), 24);
  const winches = new THREE.InstancedMesh(winchGeo, CHROME, 2);
  const _m = new THREE.Matrix4();
  winches.setMatrixAt(0, _m.setPosition(-2.05, 1.00, 0.64));
  winches.setMatrixAt(1, _m.setPosition(-2.05, 1.00, -0.64));

  // 3. mainsheet traveller bridging the coamings under the boom end
  const travBar = new THREE.Mesh(barGeo(V(-1.85, 1.01, -0.67), V(-1.85, 1.01, 0.67), 0.014), SS);
  const travCar = new THREE.Mesh(mergeGeometries([
    boxGeo(0.07, 0.035, 0.10, -1.85, 1.045, 0),
    new THREE.CylinderGeometry(0.026, 0.026, 0.05, 10).translate(-1.85, 1.09, 0),
  ]), SS);

  // 4. compass — bulkhead dome on the trunk aft face (visible from POV, −31°)
  const compass = new THREE.Mesh(new THREE.SphereGeometry(0.055, 24, 16), SMOKE);
  compass.position.set(-1.35, 1.20, 0.34);

  // 5. teak grabrails along the trunk-top edges (leading lines to the mast)
  const grabrails = [];
  for (const s of [1, -1]) {
    const zs = [0.70, 0.62, 0.54, 0.45, 0.37].map((z) => z * s);
    const xs = [-0.90, -0.15, 0.60, 1.35, 2.10];
    const pts = xs.map((x, i) => V(x, 1.36, zs[i]));
    const parts = [tubeGeo(pts, 0.016, 32, 6)];
    for (let i = 0; i < 5; i++) parts.push(boxGeo(0.035, 0.05, 0.028, xs[i], 1.335, zs[i]));
    grabrails.push(new THREE.Mesh(mergeGeometries(parts), VARN));
  }

  // 6. foredeck hatch (deck centerline at x=3.55 is y≈1.00)
  const hatchFrame = new THREE.Mesh(boxGeo(0.54, 0.06, 0.54, 3.55, 1.02, 0), swan.getObjectByName('cabinTrunk').material);
  const hatchLens  = new THREE.Mesh(boxGeo(0.46, 0.014, 0.46, 3.55, 1.058, 0), SMOKE);

  // 7. bow pulpit — bent Ø25 tube + 5 legs, inside the fine bow plan
  const pulpit = new THREE.Mesh(mergeGeometries([
    tubeGeo([V(4.30, 1.585, 0.42), V(4.90, 1.62, 0.26), V(5.42, 1.66, 0),
             V(4.90, 1.62, -0.26), V(4.30, 1.585, -0.42)], 0.0125, 32, 8),
    barGeo(V(4.35, 0.985,  0.40), V(4.35, 1.585,  0.41), 0.0125),
    barGeo(V(4.35, 0.985, -0.40), V(4.35, 1.585, -0.41), 0.0125),
    barGeo(V(5.00, 1.020,  0.19), V(5.00, 1.620,  0.20), 0.0125),
    barGeo(V(5.00, 1.020, -0.19), V(5.00, 1.620, -0.20), 0.0125),
    barGeo(V(5.35, 1.040,  0.00), V(5.35, 1.655,  0.00), 0.0125),
  ]), SS);

  // 8. stern pushpit
  const pushpit = new THREE.Mesh(mergeGeometries([
    tubeGeo([V(-4.50, 1.40, 0.78), V(-5.15, 1.43, 0.60), V(-5.52, 1.47, 0),
             V(-5.15, 1.43, -0.60), V(-4.50, 1.40, -0.78)], 0.0125, 32, 8),
    barGeo(V(-4.55, 0.820,  0.76), V(-4.55, 1.400,  0.77), 0.0125),
    barGeo(V(-4.55, 0.820, -0.76), V(-4.55, 1.400, -0.77), 0.0125),
    barGeo(V(-5.30, 0.855,  0.42), V(-5.30, 1.450,  0.43), 0.0125),
    barGeo(V(-5.30, 0.855, -0.42), V(-5.30, 1.450, -0.43), 0.0125),
  ]), SS);

  // 9. stanchions — 6/side, one 12-instance mesh; [x, deckY, |z|] from the sheer
  const STAN = [[3.9, 0.945, 0.50], [2.6, 0.900, 0.87], [1.3, 0.835, 1.16],
                [-0.2, 0.780, 1.34], [-1.7, 0.755, 1.31], [-3.2, 0.785, 1.08]];
  const stanGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.011, 0.011, 0.60, 8).translate(0, 0.30, 0),
    new THREE.CylinderGeometry(0.020, 0.026, 0.05, 8).translate(0, 0.025, 0),
  ]);
  const stanchions = new THREE.InstancedMesh(stanGeo, SS, 12);
  STAN.forEach(([x, y, z], i) => {
    stanchions.setMatrixAt(2 * i,     _m.setPosition(x, y,  z));
    stanchions.setMatrixAt(2 * i + 1, _m.setPosition(x, y, -z));
  });

  // 10. lifelines — 2/side, thin, pulpit → stanchion tops → pushpit
  const llParts = [];
  for (const s of [1, -1]) for (const h of [0.60, 0.31]) {
    const pts = [V(4.30, h === 0.60 ? 1.575 : 1.29, 0.42 * s)];
    for (const [x, y, z] of STAN) pts.push(V(x, y + h, z * s));
    pts.push(V(-4.50, h === 0.60 ? 1.40 : 1.12, 0.78 * s));
    llParts.push(tubeGeo(pts, 0.004, 64, 5));
  }
  const lifelines = new THREE.Mesh(mergeGeometries(llParts), WIRE);
  noShadow.push(lifelines);

  // 11. genoa tracks (deck rises 47 mm over the run → tilt) + working sheet
  const tracks = new THREE.Mesh(mergeGeometries([
    boxGeo(2.2, 0.03, 0.05, -0.5, 0.82,  1.18, 0.021),
    boxGeo(2.2, 0.03, 0.05, -0.5, 0.82, -1.18, 0.021),
  ]), SS);
  // (the genoa sheets + mainsheet fall are LIVE verlet ropes now — see ropes.js;
  //  only the tensioned halyards and the turns on the winch drum stay static)
  const ropes = new THREE.Mesh(mergeGeometries([
    barGeo(V(1.53, 14.40, 0.025), V(1.53, 1.05, 0.030), 0.006),   // main halyard
    barGeo(V(1.68, 14.40, -0.025), V(1.68, 1.05, -0.030), 0.006), // genoa halyard
    new THREE.TorusGeometry(0.062, 0.008, 6, 20).rotateX(Math.PI / 2).translate(-2.05, 1.085, 0.64),
    new THREE.TorusGeometry(0.062, 0.008, 6, 20).rotateX(Math.PI / 2).translate(-2.05, 1.102, 0.64),
    // coiled halyard tails hung at the mast base
    new THREE.TorusGeometry(0.09, 0.010, 6, 18).rotateZ(Math.PI / 2 - 0.2).translate(1.52, 1.28, 0.14),
    new THREE.TorusGeometry(0.085, 0.010, 6, 18).rotateZ(Math.PI / 2 - 0.35).translate(1.53, 1.26, 0.15),
    new THREE.TorusGeometry(0.09, 0.010, 6, 18).rotateZ(Math.PI / 2 + 0.15).translate(1.60, 1.27, -0.16),
  ]), ROPE);
  noShadow.push(ropes);

  // 12. lower shrouds, spreader root → chainplates
  const lowers = new THREE.Mesh(mergeGeometries([
    barGeo(V(1.60, 6.95,  0.06), V(2.05, 0.86,  1.06), 0.007),
    barGeo(V(1.60, 6.95, -0.06), V(2.05, 0.86, -1.06), 0.007),
    barGeo(V(1.60, 6.95,  0.06), V(1.10, 0.84,  1.06), 0.007),
    barGeo(V(1.60, 6.95, -0.06), V(1.10, 0.84, -1.06), 0.007),
  ]), WIRE);
  noShadow.push(lowers);

  // 13. small stainless fittings, all merged: rudder cap, bezel, cleats,
  //     chainplates, stem fitting, genoa lead cars
  const fit = [
    new THREE.CylinderGeometry(0.034, 0.038, 0.14, 12).translate(-3.44, 0.86, 0),
    new THREE.TorusGeometry(0.058, 0.009, 8, 24).rotateY(Math.PI / 2).translate(-1.345, 1.20, 0.34),
    boxGeo(0.34, 0.045, 0.07, 5.28, 1.045, 0),                    // stem head
  ];
  for (const [cx, cy, cz] of [[4.35, 0.985, 0.22], [4.35, 0.985, -0.22],
                              [-4.75, 0.85, 0.55], [-4.75, 0.85, -0.55]]) {
    fit.push(boxGeo(0.20, 0.028, 0.036, cx, cy + 0.062, cz),      // mooring cleats
             boxGeo(0.028, 0.05, 0.030, cx - 0.055, cy + 0.025, cz),
             boxGeo(0.028, 0.05, 0.030, cx + 0.055, cy + 0.025, cz));
  }
  for (const [px, pz] of [[1.60, 1.12], [2.05, 1.05], [1.10, 1.05]]) {
    fit.push(boxGeo(0.012, 0.16, 0.045, px, 0.82,  pz),           // chainplates
             boxGeo(0.012, 0.16, 0.045, px, 0.82, -pz));
  }
  for (const s of [1, -1]) {
    fit.push(boxGeo(0.06, 0.05, 0.05, -0.90, 0.865, 1.18 * s),    // genoa lead cars
             new THREE.CylinderGeometry(0.024, 0.024, 0.02, 10)
               .rotateX(Math.PI / 2).translate(-0.90, 0.90, 1.18 * s));
  }
  const fittings = new THREE.Mesh(mergeGeometries(fit), SS);

  H.add(tiller, winches, travBar, travCar, compass, ...grabrails,
        hatchFrame, hatchLens, pulpit, pushpit, stanchions, lifelines,
        tracks, ropes, lowers, fittings);
  H.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  for (const o of noShadow) o.castShadow = false;
  swan.add(H);

  // 14. boom gear — geometry baked in PIVOT-LOCAL coords (x' = x − 1.60), group
  //     placed at x = 1.60 so it renders correctly now AND survives boat.js's
  //     `o.position.x -= MAST_X` when 'boomGear' joins the sailPivot re-rig list.
  const BG = new THREE.Group(); BG.name = 'boomGear'; BG.position.set(1.60, 0, 0);
  const vang = new THREE.Mesh(barGeo(V(0.02, 1.00, 0), V(-1.15, 2.00, 0), 0.012), SS);
  const toppingLift = new THREE.Mesh(barGeo(V(0.00, 14.48, 0), V(-3.46, 2.12, 0), 0.004), WIRE);
  toppingLift.castShadow = false;
  vang.castShadow = true;
  BG.add(vang, toppingLift);          // the mainsheet fall is a live rope (ropes.js)
  swan.add(BG);

  // 15. the cabin: an open companionway you can actually see into. The trunk
  //     has a full-height notch cut in its aft face (swan36.js); this dresses
  //     it — teak frame, washboard sill, run-back hatch — and furnishes the
  //     saloon behind it: sole, settees, table, shelf, and a warm lamp.
  const cabin = new THREE.Group(); cabin.name = 'cabinInterior';
  const IVORY = new THREE.MeshStandardMaterial({
    color: 0xe8e2d2, roughness: 0.9, envMapIntensity: 0.15,
    emissive: 0x2a1d10, emissiveIntensity: 0.55,   // lamplight bounce — never pitch black below
  });
  const teakIn = new THREE.MeshStandardMaterial({ map: teak, roughness: 0.85, envMapIntensity: 0.1 });
  const CUSH = new THREE.MeshStandardMaterial({ color: 0x8a4b2e, roughness: 0.95 });   // burnt sienna
  const DARK = new THREE.MeshStandardMaterial({ color: 0x241c14, roughness: 1.0 });

  // the room, built inward-facing (x −1.26 … +1.30, floor 0.90, ceiling 1.29)
  const room = [
    boxGeo(2.56, 0.02, 1.06, 0.02, 0.90, 0),          // sole
    boxGeo(2.56, 0.02, 1.06, 0.02, 1.30, 0),          // deckhead
    boxGeo(2.56, 0.40, 0.02, 0.02, 1.10,  0.53),      // sides
    boxGeo(2.56, 0.40, 0.02, 0.02, 1.10, -0.53),
    boxGeo(0.02, 0.40, 1.06, 1.30, 1.10, 0),          // fwd bulkhead
  ];
  const shell = new THREE.Mesh(mergeGeometries(room), IVORY);
  shell.receiveShadow = true;
  // doorway to the fore cabin, dark
  const doorway = new THREE.Mesh(boxGeo(0.015, 0.30, 0.34, 1.292, 1.08, 0.05), DARK);
  // furnishings: settee cushions + backrests, table on a pedestal, shelf + books
  const furniture = new THREE.Mesh(mergeGeometries([
    boxGeo(1.7, 0.075, 0.30, 0.0, 0.955,  0.36),      // settees
    boxGeo(1.7, 0.075, 0.30, 0.0, 0.955, -0.36),
    boxGeo(1.7, 0.20, 0.05, 0.0, 1.08,  0.505),       // backrests
    boxGeo(1.7, 0.20, 0.05, 0.0, 1.08, -0.505),
  ]), CUSH);
  const woodwork = new THREE.Mesh(mergeGeometries([
    boxGeo(0.52, 0.022, 0.34, 0.05, 1.075, 0),        // saloon table
    new THREE.CylinderGeometry(0.03, 0.04, 0.16, 8).translate(0.05, 0.99, 0),
    boxGeo(1.2, 0.02, 0.10, 0.2, 1.21, 0.47),         // shelf on the side wall
    boxGeo(0.05, 0.085, 0.06, -0.10, 1.26,  0.47),    // books
    boxGeo(0.04, 0.075, 0.06, -0.03, 1.255, 0.47),
    boxGeo(0.05, 0.09, 0.06,  0.05, 1.263, 0.47),
    boxGeo(0.35, 0.004, 0.25, 0.02, 1.088, 0.02),     // chart on the table
  ]), teakIn);
  // companionway dressing: teak frame, washboard sill, hatch run back on the roof
  const frame = new THREE.Mesh(mergeGeometries([
    boxGeo(0.045, 0.42, 0.035, -1.245, 1.10,  0.315),
    boxGeo(0.045, 0.42, 0.035, -1.245, 1.10, -0.315),
    boxGeo(0.045, 0.035, 0.66, -1.245, 1.315, 0),
    boxGeo(0.03, 0.13, 0.60, -1.24, 0.955, 0),        // washboard you step over
  ]), VARN);
  const hatch = new THREE.Mesh(boxGeo(0.62, 0.025, 0.64, -0.62, 1.345, 0),
    swan.getObjectByName('cabinTrunk').material);
  hatch.castShadow = true;
  // the lamp: a warm point of life below deck
  const lampGlow = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb45e, emissiveIntensity: 2.2 }));
  lampGlow.position.set(1.24, 1.17, 0.30);
  const lampLight = new THREE.PointLight(0xffb45e, 1.6, 2.8, 1.6);
  lampLight.position.set(1.1, 1.15, 0.2);
  cabin.add(shell, doorway, furniture, woodwork, frame, hatch, lampGlow, lampLight);
  cabin.traverse((o) => { if (o.isMesh && o !== hatch) o.castShadow = false; });
  swan.add(cabin);

  // 16. dorade vents on the trunk roof — the classic pair
  const dorade = [];
  for (const s of [1, -1]) {
    dorade.push(
      boxGeo(0.22, 0.07, 0.14, 1.05, 1.355, 0.30 * s),
      new THREE.CylinderGeometry(0.045, 0.045, 0.10, 10).translate(0.98, 1.44, 0.30 * s),
      new THREE.SphereGeometry(0.058, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)
        .rotateX(-Math.PI / 2).translate(0.98, 1.49, 0.30 * s),
    );
  }
  const dorades = new THREE.Mesh(mergeGeometries(dorade), gel(0.4));
  dorades.castShadow = true;
  swan.add(dorades);

  return swan;
}
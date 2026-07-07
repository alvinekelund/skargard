import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise2D, makeFbm, mulberry32 } from './noise.js';
import { buildProps } from './props.js';
import { createSatellite } from './satellite.js';

/* ───────────────────────────────────────────────────────────────────────────
   A Finnish skärgård: irregular, LOW, glacier-smoothed granite whaleback
   skerries — a mix of bald rocks, sparsely-treed islets, and forested islands —
   clustered into shoals with open channels to sail through.
   ─────────────────────────────────────────────────────────────────────────── */

const noise = makeNoise2D(81731);
const fbm = makeFbm(noise);
const density = makeNoise2D(5519);

const COL = {
  wet:    new THREE.Color(0x3b3830), // wet rock — dark grey, lifted so shallows aren't black blobs
  foam:   new THREE.Color(0xdfe6e6),
  granite:new THREE.Color(0x796a5d), // warm grey glaciated granite
  pink:   new THREE.Color(0x9a7a68), // pink rapakivi feldspar
  grey:   new THREE.Color(0x6c6a68), // cooler grey gneiss streaks
  lichen: new THREE.Color(0xb5793a),
  moss:   new THREE.Color(0x67713f),
  heathG: new THREE.Color(0x6d6e48), // olive heath grass
  heather:new THREE.Color(0x8a6470), // dusty heather bloom (mauve-rust)
  heathBr:new THREE.Color(0x836b4c), // rusty heath
  floor:  new THREE.Color(0x44502d), // mossy forest floor (under real wood polys)
  scrubG: new THREE.Color(0x4b5a38), // grey-green juniper scrub carpet
  field:  new THREE.Color(0x91945c), // open dry meadow (satellite 'field' class)
  pine:   new THREE.Color(0x1f3a1e),
  pineDk: new THREE.Color(0x122610),
  juniper:new THREE.Color(0x36482e), // low dark-green shore bush
  birchLeaf: new THREE.Color(0x74853e),
  birchBark: new THREE.Color(0xbeb9ac),
  trunk:  new THREE.Color(0x2a2018),
  rim:    new THREE.Color(0xffc98a),
};

/* foliage material: gentle wind sway + a subtle sun-gated rim */
function makeFoliageMat(shaders, sunViewDir, { roughness = 0.85, sway = 0.09, swayLo = 1.0, swayHi = 4.5, rimStrength = 0.5 }) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0, envMapIntensity: 0.4 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uSway = { value: sway };
    sh.uniforms.uSwayLo = { value: swayLo };
    sh.uniforms.uSwayHi = { value: swayHi };
    sh.uniforms.uRim = { value: rimStrength };
    sh.uniforms.uRimColor = { value: COL.rim };
    sh.uniforms.uSunViewDir = { value: sunViewDir };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime,uSway,uSwayLo,uSwayHi; varying vec3 vRN; varying vec3 vRP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float wph=instanceMatrix[3].x*0.25+instanceMatrix[3].z*0.21;
          float hf=smoothstep(uSwayLo,uSwayHi,transformed.y);
          transformed.x+=(sin(uTime*1.05+wph)*uSway+sin(uTime*2.3+wph*1.7)*uSway*0.3)*hf;
          transformed.z+=(sin(uTime*1.05+wph)*uSway*0.6)*hf;
        #endif`)
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
        vRN=transformedNormal;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vRP=mvPosition.xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uRim; uniform vec3 uRimColor,uSunViewDir; varying vec3 vRN; varying vec3 vRP;`)
      .replace('#include <opaque_fragment>', `
        { vec3 n=normalize(vRN); vec3 v=normalize(-vRP);
          float f=pow(1.0-clamp(dot(n,v),0.0,1.0),2.0);
          float g=smoothstep(-0.15,0.55,dot(n,normalize(uSunViewDir)));
          outgoingLight+=uRimColor*f*g*uRim; }
        #include <opaque_fragment>`);
    shaders.push(sh);
  };
  return mat;
}

function paint(geo, color) {
  // normalise to non-indexed so cones/cylinders (indexed) and icosahedra (not) merge cleanly
  geo = geo.index ? geo.toNonIndexed() : geo;
  const c = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < geo.attributes.position.count; i++) { c[i*3]=color.r; c[i*3+1]=color.g; c[i*3+2]=color.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

// alpha-noise needle texture: eats into cone silhouettes so conifers read as
// ragged sprays of needles instead of smooth plastic cones
function needleTexture(seed) {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    const x = rng() * S, y = rng() * S;
    const len = 7 + rng() * 15;
    const ang = Math.PI * 0.5 + (rng() - 0.5) * 1.5;     // mostly droop downward
    const g = 120 + rng() * 90;
    ctx.strokeStyle = `rgba(${g * 0.75 | 0},${g | 0},${g * 0.7 | 0},${0.55 + rng() * 0.45})`;
    ctx.lineWidth = 1 + rng() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// clumpy leaf-cluster texture for birch canopies / juniper
function leafTexture(seed) {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, S, S);
  for (let i = 0; i < 1500; i++) {
    const x = rng() * S, y = rng() * S, r = 2 + rng() * 5;
    const g = 130 + rng() * 90;
    ctx.fillStyle = `rgba(${g * 0.82 | 0},${g | 0},${g * 0.5 | 0},${0.6 + rng() * 0.4})`;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.7, rng() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// upward blade strokes with alpha — a grass tuft card texture
function grassTexture(seed) {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) {
    const x = 8 + rng() * (S - 16);
    const lean = (x - S / 2) * 0.35 + (rng() - 0.5) * 18;
    const hgt = S * (0.45 + rng() * 0.5);
    const gsh = 120 + rng() * 80;
    ctx.strokeStyle = `rgba(${gsh * 0.9 | 0},${gsh | 0},${gsh * 0.45 | 0},${0.6 + rng() * 0.4})`;
    ctx.lineWidth = 1.2 + rng() * 1.8;
    ctx.beginPath();
    ctx.moveTo(x, S);
    ctx.quadraticCurveTo(x + lean * 0.3, S - hgt * 0.6, x + lean, S - hgt);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// two crossed cards → an instanced grass tuft (the 'field' biome, in 3D)
function grassGeometry() {
  const parts = [];
  for (const ry of [0, Math.PI / 2]) {
    const p = new THREE.PlaneGeometry(0.7, 0.45);
    p.translate(0, 0.22, 0);
    p.rotateY(ry);
    parts.push(paint(p, new THREE.Color(0x8a8d52)));
  }
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

// a reed clump — tall straw blades standing in the shallow water of
// sheltered bays (they line every soft shore in the real archipelago)
function reedGeometry() {
  const parts = [];
  for (const ry of [0, Math.PI / 2]) {
    const p = new THREE.PlaneGeometry(0.95, 2.3);
    p.translate(0, 1.12, 0);
    p.rotateY(ry);
    parts.push(paint(p, new THREE.Color(0xcdb96e)));
  }
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

// dry Phragmites straw: near-vertical pale-yellow stems with brown seed
// plumes — NOT the green grass texture, which made the belts invisible
function reedTexture(seed) {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(seed);
  ctx.clearRect(0, 0, S, S);
  for (let i = 0; i < 46; i++) {
    const x = 6 + rng() * (S - 12);
    const lean = (rng() - 0.5) * 10;
    const hgt = S * (0.72 + rng() * 0.28);
    const warm = 175 + rng() * 60;
    ctx.strokeStyle = `rgba(${warm | 0},${warm * 0.82 | 0},${warm * 0.42 | 0},${0.75 + rng() * 0.25})`;
    ctx.lineWidth = 1.4 + rng() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, S);
    ctx.quadraticCurveTo(x + lean * 0.4, S - hgt * 0.6, x + lean, S - hgt);
    ctx.stroke();
    if (rng() < 0.6) {                                  // seed plume at the tip
      ctx.fillStyle = `rgba(${110 + rng() * 40 | 0},${70 + rng() * 30 | 0},45,0.85)`;
      ctx.fillRect(x + lean - 1.6, S - hgt - 7, 3.2, 8);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// a low rounded coastal rock slab — the smooth glaciated plates the Finnish
// shore is made of (wider and flatter than a moraine boulder, lighter grey)
function slabGeometry(rng) {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const lump = 1 + 0.1 * Math.sin(x * 2.4 + 0.8) * Math.cos(z * 2.1) + 0.06 * Math.sin(y * 3.1);
    p.setXYZ(i, x * 1.45 * lump, Math.max(y, -0.15) * 0.32 * lump, z * 1.15 * lump);
  }
  geo.computeVertexNormals();
  return paint(geo, new THREE.Color(0x8d867a).lerp(new THREE.Color(0x9a8a80), rng()));
}

// a ragged, narrow spruce/pine spire — trunk and canopy split so bark stays
// solid while the foliage gets alpha-tested needle texture
function pineGeometry(rng) {
  const trunkG = new THREE.CylinderGeometry(0.045, 0.1, 1.6, 5); trunkG.translate(0, 0.8, 0);
  const trunk = paint(trunkG, COL.trunk);
  const parts = [];
  const tiers = 9;
  let y = 0.85;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = (1 - t) * 0.72 + 0.06 + (rng() - 0.5) * 0.1;     // narrows to a spire, ragged edge
    const h = 0.95 - t * 0.4;
    const cone = new THREE.ConeGeometry(Math.max(r, 0.05), h, 7);
    cone.translate((rng() - 0.5) * 0.07, y, (rng() - 0.5) * 0.07); // slight per-tier wobble
    parts.push(paint(cone, COL.pine.clone().lerp(COL.pineDk, 0.35 + t * 0.5).offsetHSL(0, 0, (rng() - 0.5) * 0.04)));
    y += h * 0.46;                                              // heavy overlap → continuous spire
  }
  return { trunk, canopy: BufferGeometryUtils.mergeGeometries(parts, false) };
}

// a loose, airy birch crown — irregular clustered blobs, muted leaf green, white trunk
function birchGeometry(rng) {
  const trunkG = new THREE.CylinderGeometry(0.04, 0.07, 3.3, 5); trunkG.translate(0, 1.65, 0);
  const trunk = paint(trunkG, COL.birchBark);
  const parts = [];
  const blobs = [
    [0, 3.3, 0, 0.95], [0.62, 3.05, 0.32, 0.66], [-0.54, 3.15, -0.3, 0.68],
    [0.22, 3.75, -0.22, 0.6], [-0.32, 3.62, 0.42, 0.55], [0.36, 4.12, 0.12, 0.46],
  ];
  for (const [x, y, z, r] of blobs) {
    const s = new THREE.IcosahedronGeometry(r, 1); s.scale(1, 0.92, 1); s.translate(x, y, z);
    parts.push(paint(s, COL.birchLeaf.clone().offsetHSL((rng() - 0.5) * 0.02, -0.06, (rng() - 0.5) * 0.09)));
  }
  return { trunk, canopy: BufferGeometryUtils.mergeGeometries(parts, false) };
}

// a low, SPREADING juniper bush (on Jurmo the juniper grows almost horizontally)
function juniperGeometry(rng) {
  const parts = [];
  const blobs = [[0, 0.18, 0, 0.8], [0.6, 0.14, 0.3, 0.6], [-0.5, 0.15, -0.25, 0.62], [0.2, 0.3, -0.4, 0.5], [-0.3, 0.22, 0.45, 0.48]];
  for (const [x, y, z, r] of blobs) {
    const s = new THREE.IcosahedronGeometry(r, 1); s.scale(1.25, 0.42, 1.25); s.translate(x, y, z);
    parts.push(paint(s, COL.juniper.clone().offsetHSL(0, 0, (rng() - 0.5) * 0.06)));
  }
  return BufferGeometryUtils.mergeGeometries(parts, false);
}

// lumpy granite boulder (Jurmo's moraine stones)
function boulderGeometry(rng) {
  const geo = new THREE.IcosahedronGeometry(1, 3);          // smoother base
  const p = geo.attributes.position;
  // gentle low-frequency lumps instead of per-vertex spikes → rounded glacial erratic
  const ax = 0.85 + rng() * 0.3, ay = 0.55 + rng() * 0.2, az = 0.85 + rng() * 0.3;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const lump = 1 + 0.12 * Math.sin(x * 3 + 1.3) * Math.cos(z * 3) + 0.1 * Math.sin(y * 2.5);
    p.setXYZ(i, x * ax * lump, y * ay * lump, z * az * lump);
  }
  geo.computeVertexNormals();
  return paint(geo, COL.grey.clone().lerp(COL.granite, 0.5));
}

// red-and-white vertical stripe texture for the Utö tower (signal flag "H")
function stripeTexture() {
  const w = 64, h = 64, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#e9e4da'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#9a2f24';
  const n = 4, sw = w / (n * 2);
  for (let i = 0; i < n; i++) ctx.fillRect((i * 2 + 0.5) * sw, 0, sw, h);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function radialGlowTexture() {
  const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(0.3, 'rgba(255,210,130,0.6)'); g.addColorStop(1, 'rgba(255,180,90,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// a soft light-shaft cone that fades along its length (additive)
function buildBeam() {
  const len = 160;
  const geo = new THREE.ConeGeometry(9, len, 20, 1, true);
  geo.translate(0, -len / 2, 0);                       // apex at origin
  const pos = geo.attributes.position;
  const aLen = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) aLen[i] = THREE.MathUtils.clamp(-pos.getY(i) / len, 0, 1);
  geo.setAttribute('aLen', new THREE.BufferAttribute(aLen, 1));
  geo.rotateX(-Math.PI / 2);                           // extend along +Z
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xffe9b4) }, uOpacity: { value: 0.0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    vertexShader: 'attribute float aLen; varying float vL; void main(){ vL=aLen; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'varying float vL; uniform vec3 uColor; uniform float uOpacity; void main(){ float a=(1.0-vL); a*=a; gl_FragColor=vec4(uColor, a*uOpacity); }',
  });
  return new THREE.Mesh(geo, mat);
}

// the Utö lighthouse: square striped granite tower, red lantern, green dome, flashing light
function buildLighthouse() {
  const g = new THREE.Group();
  const towerH = 20, tw = 5.4;
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(tw * 0.4, tw * 0.5, towerH, 4), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.78 }));
  tower.rotation.y = Math.PI / 4; tower.position.y = towerH / 2; g.add(tower);
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(tw * 0.46, tw * 0.46, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6 }));
  gallery.position.y = towerH + 0.1; g.add(gallery);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(tw * 0.3, tw * 0.32, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0x8f2c22, roughness: 0.5 }));
  lantern.position.y = towerH + 1.6; g.add(lantern);
  const core = new THREE.Mesh(new THREE.SphereGeometry(tw * 0.2, 14, 12), new THREE.MeshStandardMaterial({ color: 0xfff2cf, emissive: 0xffcf66, emissiveIntensity: 2 }));
  core.position.y = towerH + 1.6; g.add(core);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(tw * 0.34, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), new THREE.MeshStandardMaterial({ color: 0x2f5a48, roughness: 0.5, metalness: 0.2 }));
  dome.position.y = towerH + 2.9; g.add(dome);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  tip.position.y = towerH + 3.7; g.add(tip);
  const pl = new THREE.PointLight(0xffe2a0, 0, 320, 1.6); pl.position.y = towerH + 1.6; g.add(pl);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialGlowTexture(), color: 0xffe6a8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false }));
  glow.position.y = towerH + 1.6; glow.scale.setScalar(16); g.add(glow);
  // two opposed sweeping beams
  const beamPivot = new THREE.Group(); beamPivot.position.y = towerH + 1.6;
  const b1 = buildBeam(); b1.rotation.x = -0.04;
  const b2 = buildBeam(); b2.rotation.y = Math.PI; b2.rotation.x = -0.04;
  beamPivot.add(b1, b2); g.add(beamPivot);
  g.userData = { core, pl, glow, beamPivot, beamMats: [b1.material, b2.material] };
  return g;
}

// a small pilot-village house: red or pale walls, hip roof
function buildHouse(rng) {
  const g = new THREE.Group();
  const red = rng() < 0.6;
  const wall = new THREE.MeshStandardMaterial({ color: red ? 0x8a3326 : 0xd6c8af, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x39291f, roughness: 0.85 });
  const w = 2.0 + rng() * 1.0, d = 2.6 + rng() * 1.4, h = 1.3 + rng() * 0.5;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall); body.position.y = h / 2; g.add(body);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.001, Math.hypot(w, d) * 0.44, h * 0.8, 4), roofMat);
  roof.rotation.y = Math.PI / 4; roof.position.y = h + h * 0.4; g.add(roof);
  return g;
}

// ── REAL map islands: each island is an actual OSM coastline polygon from the
//    Archipelago Sea (Utö–Jurmo region), baked to public/archipelago_map.json. ──

// signed distance to the island polygon: >0 inside (metres from shore), <0 at sea.
// `cut` (mainland tiles): set of edge-start indices that are artificial clip
// seams, not coast — they still bound the polygon (sign) but are IGNORED for
// distance, so a seam between two tiles never reads as a shoreline.
function polySdf(lx, lz, ring, cut = null) {
  let inside = false, d2 = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > lz) !== (zj > lz)) && (lx < (xj - xi) * (lz - zi) / (zj - zi) + xi)) inside = !inside;
    if (cut && cut.has(j)) continue;                 // seam edge: sign only
    const dx = xj - xi, dz = zj - zi;
    const L2 = dx * dx + dz * dz || 1e-9;
    let t = ((lx - xi) * dx + (lz - zi) * dz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = xi + t * dx - lx, pz = zi + t * dz - lz;
    const dd = px * px + pz * pz;
    if (dd < d2) d2 = dd;
  }
  const d = d2 === Infinity ? 1e4 : Math.sqrt(d2);
  return inside ? d : -d;
}

// ── accelerated SDF for BIG rings (mainland tiles, Kemiönsaari-class
//    islands): the exact polySdf is O(ring) per query, and a 600-vertex
//    mainland tile meshed at 48k vertices would cost ~30M edge tests —
//    seconds per tile. Instead: bucket the distance-eligible edges into a
//    coarse cell grid (expanding-ring nearest search), and take the SIGN
//    from which side of the nearest edge the point falls on, calibrated
//    once per island against a known-inside cell. ──
function buildSdfIndex(isl) {
  const ring = isl.ring, n = ring.length, b = isl.bbox;
  const W = b.maxX - b.minX, H = b.maxZ - b.minZ;
  const cell = Math.max(30, Math.min(160, Math.sqrt(W * H) / 150));
  const nx = Math.max(2, Math.ceil(W / cell) + 2), nz = Math.max(2, Math.ceil(H / cell) + 2);
  const x0 = b.minX - cell, z0 = b.minZ - cell;
  const nat = new Array(nx * nz);                    // natural edges: distance
  const all = new Array(nx * nz);                    // every edge: parity walk
  for (let j = 0; j < n; j++) {
    const a = ring[j], c = ring[(j + 1) % n];
    const cx0 = Math.max(0, Math.floor((Math.min(a[0], c[0]) - x0) / cell));
    const cx1 = Math.min(nx - 1, Math.floor((Math.max(a[0], c[0]) - x0) / cell));
    const cz0 = Math.max(0, Math.floor((Math.min(a[1], c[1]) - z0) / cell));
    const cz1 = Math.min(nz - 1, Math.floor((Math.max(a[1], c[1]) - z0) / cell));
    const natural = !(isl.cut && isl.cut.has(j));
    for (let gz = cz0; gz <= cz1; gz++) for (let gx = cx0; gx <= cx1; gx++) {
      const k = gz * nx + gx;
      (all[k] || (all[k] = [])).push(j);
      if (natural) (nat[k] || (nat[k] = [])).push(j);
    }
  }
  // EXACT parity of every cell centre by scanline (per row: sorted ray
  // crossings, then walk the columns) — queries refine from here
  const par = new Uint8Array(nx * nz);
  for (let rz = 0; rz < nz; rz++) {
    const zc = z0 + (rz + 0.5) * cell;
    const xs = [];
    for (let j = 0; j < n; j++) {
      const i2 = (j + 1) % n;
      const zi = ring[i2][1], zj = ring[j][1];
      if ((zi > zc) !== (zj > zc)) {
        const xi = ring[i2][0], xj = ring[j][0];
        xs.push(xi + (xj - xi) * (zc - zi) / (zj - zi));
      }
    }
    xs.sort((p, q) => p - q);
    let ptr = 0;
    for (let gx = 0; gx < nx; gx++) {
      const xc = x0 + (gx + 0.5) * cell;
      while (ptr < xs.length && xs[ptr] <= xc) ptr++;
      par[rz * nx + gx] = ptr & 1;
    }
  }
  return { cell, nx, nz, x0, z0, nat, all, par };
}
function segCross(ax, az, bx, bz, cx2, cz2, dx2, dz2) {
  const o = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const o1 = o(ax, az, bx, bz, cx2, cz2), o2 = o(ax, az, bx, bz, dx2, dz2);
  const o3 = o(cx2, cz2, dx2, dz2, ax, az), o4 = o(cx2, cz2, dx2, dz2, bx, bz);
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}
// exact-parity, bucket-accelerated signed distance for big rings: the sign
// starts from the query cell's precomputed centre parity and toggles on each
// real edge crossed between centre and query point; the distance searches
// natural-edge buckets in expanding shells
function polySdfFast(lx, lz, isl) {
  if (isl.ring.length <= 140 && !isl.cut) return polySdf(lx, lz, isl.ring);
  if (!isl._sx) isl._sx = buildSdfIndex(isl);
  const S = isl._sx, ring = isl.ring, n = ring.length;
  const qx = Math.max(0, Math.min(S.nx - 1, Math.floor((lx - S.x0) / S.cell)));
  const qz = Math.max(0, Math.min(S.nz - 1, Math.floor((lz - S.z0) / S.cell)));
  let par = S.par[qz * S.nx + qx];
  const ccx = S.x0 + (qx + 0.5) * S.cell, ccz = S.z0 + (qz + 0.5) * S.cell;
  const cellEdges = S.all[qz * S.nx + qx];
  if (cellEdges) for (const j of cellEdges) {
    const a = ring[j], c = ring[(j + 1) % n];
    if (segCross(ccx, ccz, lx, lz, a[0], a[1], c[0], c[1])) par ^= 1;
  }
  let best2 = Infinity;
  const maxR = Math.max(S.nx, S.nz);
  for (let r = 0; r <= maxR; r++) {
    if (r > 1 && best2 < ((r - 1) * S.cell) * ((r - 1) * S.cell)) break;
    const gx0 = Math.max(0, qx - r), gx1 = Math.min(S.nx - 1, qx + r);
    const gz0 = Math.max(0, qz - r), gz1 = Math.min(S.nz - 1, qz + r);
    for (let gz = gz0; gz <= gz1; gz++) {
      const onZ = gz === gz0 || gz === gz1;
      for (let gx = gx0; gx <= gx1; gx++) {
        if (r > 0 && !onZ && gx !== gx0 && gx !== gx1) continue;   // shell only
        const bkt = S.nat[gz * S.nx + gx];
        if (!bkt) continue;
        for (const j of bkt) {
          const a = ring[j], c = ring[(j + 1) % n];
          const dx = c[0] - a[0], dz = c[1] - a[1];
          const L2 = dx * dx + dz * dz || 1e-9;
          let t = ((lx - a[0]) * dx + (lz - a[1]) * dz) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = a[0] + t * dx - lx, pz = a[1] + t * dz - lz;
          const dd = px * px + pz * pz;
          if (dd < best2) best2 = dd;
        }
      }
    }
  }
  const d = best2 === Infinity ? 1e4 : Math.sqrt(best2);
  return par ? d : -d;
}

// bilinear sample of a baked EU-DEM height grid (local island coords, dm ints)
function gridH(g, lx, lz) {
  const fx = (lx - g.x0) / g.dx, fz = (lz - g.z0) / g.dz;
  const ix = THREE.MathUtils.clamp(Math.floor(fx), 0, g.nx - 2);
  const iz = THREE.MathUtils.clamp(Math.floor(fz), 0, g.nz - 2);
  const tx = THREE.MathUtils.clamp(fx - ix, 0, 1), tz = THREE.MathUtils.clamp(fz - iz, 0, 1);
  const i00 = iz * g.nx + ix;
  const v = g.v;
  return ((v[i00] * (1 - tx) + v[i00 + 1] * tx) * (1 - tz)
        + (v[i00 + g.nx] * (1 - tx) + v[i00 + g.nx + 1] * tx) * tz) * 0.1;
}

// height above the real shoreline. Three tiers of honesty:
//  · grid islands — REAL interior relief (EU-DEM), pinned to 0 at the OSM ring
//  · e-only islands — REAL peak height scaling a procedural whaleback profile
//  · unresolved skerries — fully procedural low whaleback (kind/area heuristic)
function islandHeight(lx, lz, isl) {
  const b = isl.bbox;
  if (lx < b.minX - 24 || lx > b.maxX + 24 || lz < b.minZ - 24 || lz > b.maxZ + 24) return -8;
  if (isl.cut) {
    // MAINLAND tile: distance-to-real-coast drives the shore ramp; the DEM
    // grid carries the interior. Adjacent tiles sample the same globally
    // aligned lattice, so seams match; heightAt's max() hides the skirts.
    const sm = polySdfFast(lx, lz, isl);
    if (sm <= 0) return Math.max(sm * 0.55, -8.0) - 0.05;
    const shoreN = THREE.MathUtils.smoothstep(sm, 0, 60);
    let hm = isl.grid ? gridH(isl.grid, lx, lz) * shoreN
      : THREE.MathUtils.smoothstep(sm, 0, 140) * 6;        // no DEM yet: low coast
    hm += fbm((lx + isl.x) * 0.09 + (lz + isl.z) * 0.02, (lz + isl.z) * 0.09, 3) * 0.3 * shoreN;
    return hm - 0.05;
  }
  const s = polySdfFast(lx, lz, isl);
  if (s <= 0) return Math.max(s * 0.55, -8.0) - 0.05;      // gentle submerged apron
  const dome = Math.pow(THREE.MathUtils.smoothstep(s, 0, isl.S), 0.62);
  const cx = isl.x, cz = isl.z;
  let h;
  if (isl.grid) {
    // the shore rise scales with the island's height: a 58 m island climbs
    // over ~130 m like a real glaciated whaleback — NOT within 15 m like a
    // mesa with cliff walls (which is what this used to draw)
    const rise = THREE.MathUtils.clamp(isl.H * 5, 18, 130);
    const shore = THREE.MathUtils.smoothstep(s, 0, rise);
    const gh = gridH(isl.grid, lx, lz);
    // glacial hummocks between the 25 m+ DEM nodes — the bilinear alone reads
    // pancake-smooth; amplitude rides the local height so shores stay gentle
    const hum = fbm((lx + cx) * 0.026, (lz + cz) * 0.026, 2) * Math.min(gh, 9) * 0.4 * shore;
    h = Math.max(gh * shore + hum, dome * 0.9);               // land stays above water
  } else {
    h = dome * isl.H;
  }
  h += fbm((lx + cx) * 0.09 + (lz + cz) * 0.02, (lz + cz) * 0.09, 3) * 0.3 * dome; // soft swells
  h += fbm((lx + cx) * 0.32, (lz + cz) * 0.32, 2) * 0.1 * dome;                     // fine texture
  return h - 0.05;
}

// canvas name label sprite for major islands
function nameSprite(text) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.font = '500 44px Georgia, serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(255,250,240,0.92)';
  ctx.fillText(text.toUpperCase(), 256, 56);
  ctx.font = '24px Georgia, serif';
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, opacity: 0.38, depthWrite: false, fog: false });
  const spr = new THREE.Sprite(m);
  spr.scale.set(46, 11.5, 1);
  return spr;
}

// satellite land-cover class at a local island point: 0 none · 1 forest ·
// 2 field · 3 rock · 4 heath. −1 = no data for this island. Grids are baked
// from the same Esri imagery the terrain wears (tools/bake_landcover.py).
function coverAt(isl, lx, lz) {
  const c = isl.cover;
  if (!c) return -1;
  if (c.d !== undefined) return c.d;                 // small islet: dominant class
  if (!c._v) c._v = Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0));
  const ix = Math.round((lx - c.x0) / c.dx), iz = Math.round((lz - c.z0) / c.dz);
  if (ix < 0 || iz < 0 || ix >= c.nx || iz >= c.nz) return 0;
  return c._v[iz * c.nx + ix];
}

// forest test with edge dilation: a node whose 8-neighbourhood is mostly
// canopy counts as forest too, so the photo's woods read as continuous
// forest from the water instead of pin-pricked speckle
function forestAt(isl, lx, lz) {
  const c = isl.cover;
  if (!c) return false;
  if (c.d !== undefined) return c.d === 1;
  if (!c._v) c._v = Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0));
  const ix = Math.round((lx - c.x0) / c.dx), iz = Math.round((lz - c.z0) / c.dz);
  if (ix < 0 || iz < 0 || ix >= c.nx || iz >= c.nz) return false;
  if (c._v[iz * c.nx + ix] === 1) return true;
  let votes = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dz) continue;
    const jx = ix + dx, jz = iz + dz;
    if (jx < 0 || jz < 0 || jx >= c.nx || jz >= c.nz) continue;
    if (c._v[jz * c.nx + jx] === 1) votes++;
  }
  return votes >= 4;
}

// is a world point inside any of the land-cover entries ({p: ring, minX..maxZ})?
function inCover(list, x, z) {
  for (const n of list) {
    if (x < n.minX || x > n.maxX || z < n.minZ || z > n.maxZ) continue;
    if (inRing(x, z, n.p)) return true;
  }
  return false;
}

// point-in-polygon (ring = [[x,z],...], world coords)
export function inRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (((r[i][1] > z) !== (r[j][1] > z)) &&
        (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) inside = !inside;
  }
  return inside;
}

export function buildArchipelago(scene, env, mapData, realData, coverData = null, roadsData = null) {
  const group = new THREE.Group();
  scene.add(group);
  const shaders = [];
  const sunViewDir = new THREE.Vector3();

  // real aerial imagery streamed per region and draped on the granite
  const satellite = createSatellite();
  let satOn = true;      // togglable (V) — falls back to stylised granite when off
  let satBlend = 0;      // eased drape strength driven each frame

  // foliage: alpha-tested needle/leaf textures break the smooth silhouettes
  const needleTex = needleTexture(77); needleTex.repeat.set(3, 1);
  const leafTex = leafTexture(78); leafTex.repeat.set(2, 2);
  const pineMat = makeFoliageMat(shaders, sunViewDir, { roughness: 0.82, sway: 0.08, swayLo: 1.2, swayHi: 4.4, rimStrength: 0.5 });
  pineMat.map = needleTex; pineMat.alphaTest = 0.45; pineMat.side = THREE.DoubleSide;
  const birchMat = makeFoliageMat(shaders, sunViewDir, { roughness: 0.7, sway: 0.13, swayLo: 1.0, swayHi: 4.5, rimStrength: 0.45 });
  birchMat.map = leafTex; birchMat.alphaTest = 0.4; birchMat.side = THREE.DoubleSide;
  const trunkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.3 });

  // ── granite material: triplanar PBR (real rock detail) under the vertex-colour
  //    ecological tints, glossy wet shoreline, animated foam line ──
  const texLoader = new THREE.TextureLoader();
  const B = import.meta.env.BASE_URL;
  const rockD = texLoader.load(B + 'rock_diff.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; });
  const rockN = texLoader.load(B + 'rock_nor.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; });
  const rockR = texLoader.load(B + 'rock_rough.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; });

  const islandShaders = [];
  const islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0, envMapIntensity: 0.4 });
  islandMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uRockD = { value: rockD };
    sh.uniforms.uRockN = { value: rockN };
    sh.uniforms.uRockR = { value: rockR };
    sh.uniforms.uSat = { value: satellite.texture };
    sh.uniforms.uSatBox = { value: satellite.box };   // live Vector4 (x0,z0,w,h)
    sh.uniforms.uSatOn = { value: 0 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWPos = worldPosition.xyz;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n vWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform sampler2D uRockD, uRockN, uRockR;
        uniform sampler2D uSat; uniform vec4 uSatBox; uniform float uSatOn;
        varying vec3 vWPos; varying vec3 vWNrm;
        vec3 triW() { vec3 w = pow(abs(vWNrm), vec3(4.0)); return w / (w.x + w.y + w.z); }
        vec4 triSample(sampler2D t, float s) {
          vec3 w = triW();
          return texture2D(t, vWPos.zy * s) * w.x
               + texture2D(t, vWPos.xz * s) * w.y
               + texture2D(t, vWPos.xy * s) * w.z;
        }`)
      // albedo: two-scale rock detail (noise-masked so contrast survives) modulates
      // the ecological vertex tint; mean-normalised so tints keep their value.
      // Then the REAL aerial photo of this exact spot is draped over the land.
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 texA = triSample(uRockD, 0.16).rgb;
          vec3 texB = triSample(uRockD, 0.047).rgb;
          float m = smoothstep(-0.3, 0.3, sin(vWPos.x * 0.37) * sin(vWPos.z * 0.29));
          vec3 tex = mix(texA, texB, m * 0.6 + 0.2);
          vec3 detail = clamp(tex / vec3(0.22, 0.21, 0.20), 0.35, 1.9);
          diffuseColor.rgb *= mix(vec3(1.0), detail, 0.85);
        }
        if (uSatOn > 0.001) {
          vec2 suv = (vWPos.xz - uSatBox.xy) / uSatBox.zw;
          if (suv.x > 0.002 && suv.x < 0.998 && suv.y > 0.002 && suv.y < 0.998) {
            vec3 sat = texture2D(uSat, suv).rgb;
            sat = pow(sat * 1.5, vec3(0.92));              // lift the aerial exposure so it reads at dusk too
            float land = smoothstep(0.1, 0.55, vWPos.y);  // keep the wet granite only at the very shore
            // tiny skerries are sub-pixel in the photo, so their pixel is SEA —
            // dark blue-green paint made them look like teal pillows. Reject
            // water-looking pixels and let the granite show instead.
            float luma = dot(sat, vec3(0.299, 0.587, 0.114));
            float waterLike = (1.0 - smoothstep(0.16, 0.30, luma)) * step(sat.r, sat.b * 1.25);
            land *= 1.0 - waterLike;
            diffuseColor.rgb = mix(diffuseColor.rgb, sat, land * uSatOn);
          }
        }`)
      // triplanar normal perturbation (world-space whiteout blend → view space)
      .replace('#include <normal_fragment_maps>', `
        {
          vec3 w = triW();
          vec3 nX = texture2D(uRockN, vWPos.zy * 0.16).xyz * 2.0 - 1.0;
          vec3 nY = texture2D(uRockN, vWPos.xz * 0.16).xyz * 2.0 - 1.0;
          vec3 nZ = texture2D(uRockN, vWPos.xy * 0.16).xyz * 2.0 - 1.0;
          float str = 0.85;
          vec3 aN = abs(vWNrm);
          vec3 sN = sign(vWNrm);
          vec3 wn = normalize(vWNrm
            + str * (w.x * vec3(0.0, nX.y, nX.x * sN.x)
                   + w.y * vec3(nY.x, 0.0, nY.y) * vec3(1.0, 1.0, 1.0) * sN.y
                   + w.z * vec3(nZ.x, nZ.y, 0.0) * vec3(sN.z, 1.0, 0.0)));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`)
      // roughness: rock micro-variation + glossy wet band at the waterline
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        {
          float texR = triSample(uRockR, 0.16).r;
          roughnessFactor = mix(0.82, 1.0, texR);              // glaciated granite stays matte
          float wet = 1.0 - smoothstep(0.05, 0.45, vWPos.y);
          roughnessFactor = mix(roughnessFactor, 0.32, wet * 0.75); // wet rock catches the sunset
        }`)
      .replace('#include <opaque_fragment>', `
        {
          float wy = vWPos.y;
          float band = smoothstep(0.02, 0.09, wy) * (1.0 - smoothstep(0.14, 0.28, wy));
          float n = sin(vWPos.x * 0.6 + uTime * 1.4) * sin(vWPos.z * 0.55 - uTime * 1.1)
                  + 0.5 * sin(vWPos.x * 1.7 - uTime * 0.8) * sin(vWPos.z * 1.9 + uTime * 0.9);
          float foam = band * smoothstep(0.35, 0.95, n * 0.4 + 0.5);
          outgoingLight += vec3(0.86, 0.93, 0.97) * foam * 0.34;
        }
        #include <opaque_fragment>`);
    islandShaders.push(sh);
  };

  const juniperMat = makeFoliageMat(shaders, sunViewDir, { roughness: 0.85, sway: 0.05, swayLo: 0.2, swayHi: 1.2, rimStrength: 0.35 });
  juniperMat.map = leafTex; juniperMat.alphaTest = 0.35; juniperMat.side = THREE.DoubleSide;
  const grassTex = grassTexture(91);
  const grassMat = makeFoliageMat(shaders, sunViewDir, { roughness: 0.9, sway: 0.16, swayLo: 0.0, swayHi: 0.45, rimStrength: 0.4 });
  grassMat.map = grassTex; grassMat.alphaTest = 0.28; grassMat.side = THREE.DoubleSide;
  const reedTex = reedTexture(47);
  const reedMat = makeFoliageMat(shaders, sunViewDir, { roughness: 0.85, sway: 0.22, swayLo: 0.0, swayHi: 0.6, rimStrength: 0.5 });
  reedMat.map = reedTex; reedMat.alphaTest = 0.26; reedMat.side = THREE.DoubleSide;
  const pineGeo = pineGeometry(mulberry32(1));
  const birchGeo = birchGeometry(mulberry32(2));
  const juniperGeo = juniperGeometry(mulberry32(3));
  const boulderGeo = boulderGeometry(mulberry32(4));
  const grassGeo = grassGeometry();
  const reedGeo = reedGeometry();
  const slabGeo = slabGeometry(mulberry32(6));
  const boulderMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.4 });
  let pineMats = [], birchMats = [], juniperMats = [], boulderMats = [], grassMats = [], slabMats = [], reedMats = [];
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0,1,0);

  // ── islands from the REAL chart: every polygon is an actual island outline
  //    from OSM (Utö–Jurmo region, Archipelago Sea), uniformly compressed. ──
  const rng = mulberry32(20260613);
  const islands = [];
  const coverIslands = (coverData && coverData.islands) || null;
  let recIndex = -1;
  for (const rec of (mapData ? mapData.islands : [])) {
    recIndex++;
    const pts = rec.p;
    let cx = 0, cz = 0;
    for (const [x, z] of pts) { cx += x; cz += z; }
    cx /= pts.length; cz /= pts.length;
    const ring = pts.map(([x, z]) => [x - cx, z - cz]);
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (const [x, z] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    // mainland coastline tiles carry q = cut-edge start indices (artificial
    // clip seams); they scatter like forest but ramp height off real coast only
    const cut = rec.q && rec.q.length ? new Set(rec.q) : null;
    const A = rec.a, kind = rec.k === 'mainland' ? 'forest' : rec.k;
    const lg = Math.log10(Math.max(A / 300, 1));
    // REAL max height (EU-DEM, baked in dm) when the raster resolved the island;
    // otherwise the old kind/area heuristic — flagged so the data overlay can tell
    const e = rec.e ? rec.e / 10 : 0;
    const H = e > 0 ? Math.max(e, 0.7)
      : kind === 'bald' ? 0.7 + 0.4 * lg : kind === 'sparse' ? 1.2 + 1.2 * lg : 2.2 + 1.6 * lg;
    islands.push({
      x: cx, z: cz, ring, bbox: { minX, minZ, maxX, maxZ },
      A, R: Math.sqrt(A / Math.PI), H,
      // rise length grows with real height too — tall islands must not jump
      // straight from the water (S is the whaleback's shore-to-crown distance)
      S: THREE.MathUtils.clamp(Math.max(Math.sqrt(A) * 0.14, (e > 0 ? e : 0) * 4.5), 4, 130),
      kind, name: rec.n || null, cut,
      realElev: e > 0, grid: rec.g || null,
      cover: coverIslands ? coverIslands[String(recIndex)] || null : null,   // satellite-classified land cover
    });
  }

  // real roads (OSM highways) with bboxes for region filtering
  const roads = (roadsData && roadsData.roads ? roadsData.roads : []).map((r) => {
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (const [x, z] of r.p) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { c: r.c, p: r.p, minX, minZ, maxX, maxZ };
  });

  // real land cover: wood/forest (c=0), heath (1), scrub (2) — with bboxes
  const nature = (realData && realData.nature ? realData.nature : []).map((n) => {
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (const [x, z] of n.p) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { c: n.c, p: n.p, minX, minZ, maxX, maxZ };
  });

  // the world is 60×55 km at 1:1 — only the region around the boat is built;
  // rebuild() streams a new region in when the boat moves or teleports
  let geoParts = [];
  let treeBudget = 14000;
  let grassBudget = 6000, slabBudget = 1300, reedBudget = 2200;

  const perf = { mesh: 0, color: 0, scatter: 0 };
  function buildIsland(isl) {
    const { x: cx, z: cz, bbox, H, kind } = isl;
    let tp = performance.now();
    const M = 14;                                     // underwater apron margin
    const w = bbox.maxX - bbox.minX + M * 2, d = bbox.maxZ - bbox.minZ + M * 2;
    const segX = THREE.MathUtils.clamp(Math.round(w * 0.5), 8, 140);
    const segZ = THREE.MathUtils.clamp(Math.round(d * 0.5), 8, 140);
    const geo = new THREE.PlaneGeometry(w, d, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const ox = (bbox.minX + bbox.maxX) / 2, oz = (bbox.minZ + bbox.maxZ) / 2;
    geo.translate(ox, 0, oz);                         // grid over the polygon's bbox
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, islandHeight(pos.getX(i), pos.getZ(i), isl));
    geo.computeVertexNormals();
    perf.mesh += performance.now() - tp; tp = performance.now();

    const nrm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const tmp = new THREE.Color(), hc = new THREE.Color();
    // REAL land cover paints the ground: OSM wood → forest floor, heath → heather
    // carpet (Jurmo), scrub → juniper green. Unmapped ground keeps the procedural
    // granite/heath heuristic — most tiny skerries genuinely are bare rock.
    const hasCoverPolys = isl._wood.length + isl._heath.length + isl._scrub.length > 0;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), y = pos.getY(i), lz = pos.getZ(i);
      const slope = nrm.getY(i);
      const patch = fbm((lx + cx) * 0.13, (lz + cz) * 0.13, 3) * 0.5 + 0.5;
      const grain = fbm((lx + cx) * 0.6, (lz + cz) * 0.6, 2) * 0.5 + 0.5;
      if (y < 0.42) {
        // wet rock reads as grey granite (not a black blob); only a thin dark splash
        // line hugs the very waterline, with a crisp foam fringe
        const wetMix = THREE.MathUtils.smoothstep(y, 0.0, 0.42);
        tmp.copy(COL.wet).lerp(COL.granite, wetMix);
        const surf = THREE.MathUtils.smoothstep(y, 0.02, 0.1) * (1 - THREE.MathUtils.smoothstep(y, 0.14, 0.26));
        tmp.lerp(COL.foam, surf * grain * 0.3);
      } else {
        let cover = 0;                               // 0 unmapped · 1 wood · 2 heath · 3 scrub · 4 field
        if (isl.cover) {                             // the satellite classification decides
          const sc = coverAt(isl, lx, lz);
          cover = sc === 1 ? 1 : sc === 4 ? 2 : sc === 2 ? 4 : 0;   // photo forest/heath/field
        } else if (hasCoverPolys) {
          const wx = lx + cx, wz = lz + cz;
          if (inCover(isl._wood, wx, wz)) cover = 1;
          else if (inCover(isl._heath, wx, wz)) cover = 2;
          else if (inCover(isl._scrub, wx, wz)) cover = 3;
        }
        const streak = fbm((lx + cx) * 0.3, (lz + cz) * 0.04, 2) * 0.5 + 0.5; // glaciated striae
        tmp.copy(COL.granite).lerp(COL.pink, grain * 0.6);
        tmp.lerp(COL.grey, THREE.MathUtils.smoothstep(streak, 0.55, 0.85) * 0.45);
        tmp.lerp(COL.lichen, THREE.MathUtils.smoothstep(patch, 0.62, 0.88) * THREE.MathUtils.clamp(slope, 0, 1) * 0.4);
        const bloom = fbm((lx + cx) * 0.22, (lz + cz) * 0.22, 3) * 0.5 + 0.5;
        if (cover === 1) {
          // mapped forest: mossy floor + humus, rock pokes through on steep faces
          hc.copy(COL.floor).lerp(COL.moss, THREE.MathUtils.smoothstep(bloom, 0.4, 0.8) * 0.6);
          tmp.lerp(hc, (0.55 + patch * 0.3) * THREE.MathUtils.smoothstep(slope, 0.55, 0.8));
        } else if (cover === 3) {
          // mapped scrub: continuous grey-green juniper carpet
          hc.copy(COL.scrubG).lerp(COL.juniper, THREE.MathUtils.smoothstep(bloom, 0.35, 0.75) * 0.5);
          tmp.lerp(hc, (0.5 + patch * 0.25) * THREE.MathUtils.smoothstep(slope, 0.55, 0.8));
        } else if (cover === 4) {
          // photo field: open dry Nordic meadow
          hc.copy(COL.field).lerp(COL.heathG, THREE.MathUtils.smoothstep(bloom, 0.45, 0.85) * 0.4);
          tmp.lerp(hc, (0.6 + patch * 0.25) * THREE.MathUtils.smoothstep(slope, 0.5, 0.75));
        } else {
          // heather + juniper heath carpets the flatter ground — the Jurmo signature.
          // Where OSM maps real heath, the carpet is near-total instead of a heuristic.
          let heathMask = THREE.MathUtils.smoothstep(slope, 0.72, 0.94) * THREE.MathUtils.smoothstep(y, 0.28, 1.1) * (0.55 + patch * 0.45);
          if (cover === 2) heathMask = Math.max(heathMask, 0.85 * THREE.MathUtils.smoothstep(slope, 0.55, 0.8));
          hc.copy(COL.heathG)
            .lerp(COL.heathBr, THREE.MathUtils.smoothstep(bloom, 0.32, 0.58))
            .lerp(COL.heather, THREE.MathUtils.smoothstep(bloom, 0.58, 0.86));
          tmp.lerp(hc, heathMask * 0.92);
        }
      }
      tmp.offsetHSL(0, 0, (grain - 0.5) * 0.05);
      colors[i*3]=tmp.r; colors[i*3+1]=tmp.g; colors[i*3+2]=tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.translate(cx, 0, cz);                          // into world space for the merge
    geoParts.push(geo);
    perf.color += performance.now() - tp; tp = performance.now();

    const treeRng = mulberry32(Math.floor((cx + 9999) * 53 + (cz + 9999) * 131));
    const bw = bbox.maxX - bbox.minX, bd = bbox.maxZ - bbox.minZ;
    const samp = () => [bbox.minX + treeRng() * bw, bbox.minZ + treeRng() * bd];

    // On the big islands, uniform sampling drowns the tree budget in an
    // interior nobody can see from a boat — the whole visual weight of a
    // forested island is its first ~350 m of shoreline. So big islands
    // spend their trees in a shore band, edge-length-weighted along the
    // real OSM ring (the interior keeps its painted canopy tint).
    const ring = isl.ring;
    let sampShore = null;
    if (isl.A > 3e6) {
      // only the ring edges inside the build radius count — a 60 km coastline
      // would otherwise dilute the trees onto shores no one is near
      const edges = [];
      let total = 0;
      for (let i = 0; i < ring.length; i++) {
        if (isl.cut && isl.cut.has(i)) continue;      // seams grow no shore trees
        const a = ring[i], q = ring[(i + 1) % ring.length];
        const mx = cx + (a[0] + q[0]) / 2, mz = cz + (a[1] + q[1]) / 2;
        if (Math.abs(mx - activeCenter.x) > RBUILD + 400 || Math.abs(mz - activeCenter.y) > RBUILD + 400) continue;
        total += Math.hypot(q[0] - a[0], q[1] - a[1]);
        edges.push([a, q, total]);
      }
      if (edges.length) sampShore = () => {
        const u = treeRng() * total;
        let lo = 0, hi = edges.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (edges[mid][2] < u) lo = mid + 1; else hi = mid; }
        const [a, b2] = edges[lo];
        const t = treeRng();
        const x = a[0] + (b2[0] - a[0]) * t, z = a[1] + (b2[1] - a[1]) * t;
        let nx = -(b2[1] - a[1]), nz = b2[0] - a[0];
        const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
        // ring winding is unknown — probe which side is land
        if (islandHeight(x + nx * 22, z + nz * 22, isl) < islandHeight(x - nx * 22, z - nz * 22, isl)) { nx = -nx; nz = -nz; }
        const d = 14 + treeRng() * treeRng() * 336;   // biased toward the waterline
        return [x + nx * d, z + nz * d, d];
      };
    }

    // ONLY proper forested islands carry trees. Small skerries are bare granite
    // with at most a little juniper scrub — never trees (that's the un-Finnish tell).
    // When the island has a SATELLITE cover grid, the photo decides instead:
    // trees exactly where the imagery shows canopy, nothing where it shows
    // field or bare rock.
    const hasWood = isl._wood && isl._wood.length > 0;
    const hasHeath = isl._heath && isl._heath.length > 0;
    const satGrid = !!(isl.cover && isl.cover.b64);
    const satForest = satGrid || (isl.cover && isl.cover.d === 1);
    // how forested the photo says this island is overall. The z14 classifier
    // under-calls dark pine (reads it heath / leaves it unclassified), so on
    // an island that is clearly forested we let those pixels carry trees too —
    // while genuinely open islands (Jurmo's moraine heath) stay bare.
    if (satGrid && isl._forestShare === undefined) {
      const c = isl.cover;
      if (!c._v) c._v = Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0));
      let f = 0, land = 0;
      for (let k = 0; k < c._v.length; k++) { const v = c._v[k]; if (v > 0) { land++; if (v === 1) f++; } }
      isl._forestShare = land ? f / land : 0;
    }
    if (isl.cover ? satForest : (kind === 'forest' || hasWood)) {
      // base bonus scales with area: a flat constant times 50 skerries used
      // to drain the whole region budget before the main island's turn
      const base = satGrid || hasWood ? Math.min(Math.ceil(isl.A * 0.012), 260) : 0;
      const target = Math.min(Math.floor(isl.A * (satGrid ? 0.009 : 0.006)) + base, 2600, treeBudget);
      treeBudget -= target;
      let placed = 0, tries = 0;
      while (placed < target && tries < target * 8) {
        tries++;
        const sp = sampShore ? sampShore() : samp();
        const [lx, lz] = sp;
        const y = islandHeight(lx, lz, isl);
        // shore-band samples know their true distance to the waterline, and on
        // the big DEM islands the ramp is so gentle that a height cutoff would
        // strip the first 100 m of coast bare — pines grow to the rock's edge
        if (sp[2] !== undefined ? (y < 0.12 || y > H + 4.0) : (y < 0.9 || y > H + 4.0)) continue;
        if (satGrid) {                             // the PHOTO decides (dilated)
          if (!forestAt(isl, lx, lz)) {
            // classifier bias correction on demonstrably forested islands:
            // its 'heath' and unclassified pixels there are mostly dark pine
            const cl = coverAt(isl, lx, lz);
            const share = isl._forestShare;
            if (!(share > 0.22 && (cl === 4 || cl === 0) && treeRng() < (cl === 4 ? 0.65 : 0.4))) continue;
          }
        } else if (hasWood) {                      // else the OSM forest boundary
          if (!inCover(isl._wood, cx + lx, cz + lz)) continue;
        } else if (hasHeath) {
          if (inCover(isl._heath, cx + lx, cz + lz)) continue; // mapped heath stays treeless
        }
        if (nearRoad(cx + lx, cz + lz)) continue;  // keep the gravel cut open
        const e = 0.6;
        const dy = Math.hypot(
          islandHeight(lx+e,lz,isl) - islandHeight(lx-e,lz,isl),
          islandHeight(lx,lz+e,isl) - islandHeight(lx,lz-e,isl)) / (2*e);
        if (dy > 1.0 && treeRng() > 0.3) continue;
        const isBirch = treeRng() < 0.18;     // pine/spruce dominant, birch the accent
        // REAL Nordic forest scale: mature 15–26 m canopy on the big sheltered
        // islands, wind-stunted 5–12 m out on the exposed skerries — a pine
        // must dwarf a house, not match it
        const maturity = isl.A > 600000 ? 2.3 : isl.A > 120000 ? 1.8 : 1.15;
        const sc = ((isBirch ? 0.8 : 0.7) + treeRng() * (isBirch ? 0.7 : 1.5)) * maturity;
        _p.set(cx + lx, y - 0.15, cz + lz);
        _s.set(sc * (0.85 + treeRng() * 0.3), sc, sc * (0.85 + treeRng() * 0.3));
        _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
        _m.compose(_p, _q, _s);
        (isBirch ? birchMats : pineMats).push(_m.clone());
        placed++;
      }
    }

    // low juniper + heather scrub — the heath that carpets these islands.
    // With a satellite grid: juniper keeps off the photo's forests and fields.
    const jtarget = Math.min(Math.floor(isl.A * (kind === 'bald' ? 0.011 : kind === 'sparse' ? 0.02 : 0.008)), 240);
    let jp = 0, jt = 0;
    while (jp < jtarget && jt < jtarget * 8) {
      jt++;
      const [lx, lz] = samp();
      const y = islandHeight(lx, lz, isl);
      if (y < 0.3 || y > H + 0.4) continue;
      if (satGrid) { const cl = coverAt(isl, lx, lz); if (cl === 1 || cl === 2) continue; }
      if (nearRoad(cx + lx, cz + lz)) continue;
      const sc = 0.7 + treeRng() * 1.1;
      _p.set(cx + lx, y - 0.06, cz + lz);
      _s.set(sc, sc * (0.7 + treeRng() * 0.5), sc);
      _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
      _m.compose(_p, _q, _s);
      juniperMats.push(_m.clone());
      jp++;
    }

    // scattered moraine boulders (Jurmo's "stone kingdom") on the bare rocks —
    // with a satellite grid they cluster where the photo shows bare ground
    const btarget = Math.min(Math.floor(isl.A * (kind === 'forest' ? 0.003 : 0.008)), 160);
    let bp = 0, bt = 0;
    while (bp < btarget && bt < btarget * 8) {
      bt++;
      const [lx, lz] = samp();
      const y = islandHeight(lx, lz, isl);
      if (y < 0.15 || y > H + 0.3) continue;
      if (satGrid) { const cl = coverAt(isl, lx, lz); if (cl !== 3 && cl !== 4 && treeRng() < 0.75) continue; }
      if (nearRoad(cx + lx, cz + lz)) continue;
      const sc = 0.5 + treeRng() * 1.6;
      _p.set(cx + lx, y - 0.1, cz + lz);
      _s.set(sc * (0.8 + treeRng() * 0.5), sc * (0.6 + treeRng() * 0.4), sc * (0.8 + treeRng() * 0.5));
      _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
      _m.compose(_p, _q, _s);
      boulderMats.push(_m.clone());
      bp++;
    }

    // ── the biomes in 3D, straight off the satellite grid: grass tufts on
    //    every 'field' node, smooth rock slabs on low 'rock' ground ──
    if (satGrid && (grassBudget > 0 || slabBudget > 0)) {
      const c = isl.cover;
      if (!c._v) c._v = Uint8Array.from(atob(c.b64), (ch) => ch.charCodeAt(0));
      for (let iz = 0; iz < c.nz; iz++) {
        for (let ix = 0; ix < c.nx; ix++) {
          const cls = c._v[iz * c.nx + ix];
          if (cls !== 2 && cls !== 3) continue;
          const nlx = c.x0 + ix * c.dx, nlz = c.z0 + iz * c.dz;
          if (cls === 2 && grassBudget > 0) {
            const tufts = Math.min(3, grassBudget);
            for (let k = 0; k < tufts; k++) {
              const glx = nlx + (treeRng() - 0.5) * c.dx, glz = nlz + (treeRng() - 0.5) * c.dz;
              const gy = islandHeight(glx, glz, isl);
              if (gy < 0.35) continue;
              const sc = 0.8 + treeRng() * 1.3;
              _p.set(cx + glx, gy - 0.03, cz + glz);
              _s.set(sc, sc * (0.8 + treeRng() * 0.5), sc);
              _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
              _m.compose(_p, _q, _s);
              grassMats.push(_m.clone());
              grassBudget--;
            }
          } else if (cls === 3 && slabBudget > 0 && treeRng() < 0.2) {
            const slx = nlx + (treeRng() - 0.5) * c.dx, slz = nlz + (treeRng() - 0.5) * c.dz;
            const sy = islandHeight(slx, slz, isl);
            if (sy < 0.2 || sy > 5.0) continue;            // the smooth coastal shelves
            const sc = 1.1 + treeRng() * 2.6;
            _p.set(cx + slx, sy - 0.25, cz + slz);
            _s.set(sc * (0.8 + treeRng() * 0.5), sc * 0.5, sc * (0.8 + treeRng() * 0.5));
            _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
            _m.compose(_p, _q, _s);
            slabMats.push(_m.clone());
            slabBudget--;
          }
          // reed belts: SHELTERED shore nodes (mostly land around, soft cover)
          // — the clumps must stand in the SHALLOWS, so each sample walks
          // outward toward the water neighbours until it gets wet
          if (reedBudget > 0 && treeRng() < 0.85) {
            let land = 0, wox = 0, woz = 0;
            for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
              const jx = ix + ox, jz2 = iz + oz;
              const isLand = jx >= 0 && jz2 >= 0 && jx < c.nx && jz2 < c.nz && c._v[jz2 * c.nx + jx] > 0;
              if (isLand) land++;
              else { wox += ox; woz += oz; }
            }
            if (land >= 3 && land <= 7) {                  // a sheltered edge
              const wl = Math.hypot(wox, woz) || 1;
              for (let k = 0; k < 4 && reedBudget > 0; k++) {
                for (const stepT of [0.5, 0.9, 1.4, 2.0]) {
                  const rlx = nlx + (wox / wl) * c.dx * stepT + (treeRng() - 0.5) * c.dx * 0.5;
                  const rlz = nlz + (woz / wl) * c.dz * stepT + (treeRng() - 0.5) * c.dz * 0.5;
                  const ry = islandHeight(rlx, rlz, isl);
                  if (ry < -1.3 || ry > 0.2) continue;
                  const sc = 0.75 + treeRng() * 0.6;
                  _p.set(cx + rlx, Math.min(ry, -0.05), cz + rlz);
                  _s.set(sc, sc * (0.85 + treeRng() * 0.35), sc);
                  _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
                  _m.compose(_p, _q, _s);
                  reedMats.push(_m.clone());
                  reedBudget--;
                  break;
                }
              }
            }
          }
        }
      }
    }
    perf.scatter += performance.now() - tp;
  }

  // shared depth materials so alpha-tested canopies cast needle-shaped shadows
  const depthNeedle = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: needleTex, alphaTest: 0.45 });
  const depthLeaf = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.38 });

  // ── streaming region state ──
  const RBUILD = 3500;                    // metres of world built around the boat
  const REBUILD_AT = 1200;                // rebuild when the boat strays this far
  const MAX_ISLANDS = 550;                // densest inner-archipelago cap
  const activeGroup = new THREE.Group();
  group.add(activeGroup);
  let activeSet = [];
  let landmark = null;
  let propsRef = null;
  const activeCenter = new THREE.Vector2(1e9, 1e9);

  // ── data overlay (D): draw exactly what comes from real data ──
  let debugOn = false;
  let debugGroup = null;
  let lastCounts = null;
  // x-ray lines: no depth test so the data reads through terrain in any light
  const dbgLine = (color) => new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
  });
  const DBG_MAT = {
    measured: dbgLine(0x2fd6c4),    // teal: EU-DEM-measured height
    procedural: dbgLine(0xff9b45),  // orange: heuristic height (raster couldn't resolve)
    wood: dbgLine(0x46d95e),
    heath: dbgLine(0xc46bd4),
    scrub: dbgLine(0xe0cf4a),
  };
  Object.values(DBG_MAT).forEach((m) => { m.__shared = true; });

  function ringLine(pts, y, mat) {
    const arr = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      arr[i * 3] = pts[i][0];
      arr[i * 3 + 1] = typeof y === 'function' ? y(pts[i][0], pts[i][1]) : y;
      arr[i * 3 + 2] = pts[i][1];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const line = new THREE.LineLoop(geo, mat);
    line.renderOrder = 999;
    return line;
  }

  function buildDebugOverlay() {
    debugGroup = new THREE.Group();
    // every island shoreline IS real OSM — colour says where the HEIGHT comes from
    for (const isl of activeSet) {
      const world = isl.ring.map(([x, z]) => [x + isl.x, z + isl.z]);
      debugGroup.add(ringLine(world, 0.9, isl.realElev ? DBG_MAT.measured : DBG_MAT.procedural));
    }
    // real land-cover polygons, draped over the terrain
    const seen = new Set();
    for (const isl of activeSet) {
      for (const [list, mat] of [[isl._wood, DBG_MAT.wood], [isl._heath, DBG_MAT.heath], [isl._scrub, DBG_MAT.scrub]]) {
        for (const n of list) {
          if (seen.has(n)) continue;
          seen.add(n);
          debugGroup.add(ringLine(n.p, (x, z) => Math.max(heightAt(x, z), 0) + 1.0, mat));
        }
      }
    }
    activeGroup.add(debugGroup);   // disposeActive cleans it with the region
  }

  function setDebug(on) {
    debugOn = on;
    if (debugGroup) {
      activeGroup.remove(debugGroup);
      debugGroup.traverse((c) => { if (c.isLine) c.geometry.dispose(); });
      debugGroup = null;
    }
    if (on) buildDebugOverlay();
    return on ? lastCounts : null;
  }

  function disposeActive() {
    for (const o of [...activeGroup.children]) {
      o.traverse((c) => {
        if (c.isMesh || c.isSprite || c.isLine) {
          if (c.geometry && !c.geometry.__shared) c.geometry.dispose();
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          for (const m of mats) {
            if (m && !m.__shared) { if (m.map && !m.map.__shared) m.map.dispose(); m.dispose(); }
          }
        }
        if (c.isInstancedMesh) c.dispose();
      });
      activeGroup.remove(o);
    }
  }
  // shared assets must survive dispose
  for (const m of [islandMat, pineMat, birchMat, trunkMat, juniperMat, boulderMat, grassMat, reedMat, depthNeedle, depthLeaf]) m.__shared = true;
  for (const t of [needleTex, leafTex, grassTex, rockD, rockN, rockR]) t.__shared = true;
  for (const g of [pineGeo.trunk, pineGeo.canopy, birchGeo.trunk, birchGeo.canopy, juniperGeo, boulderGeo, grassGeo, slabGeo, reedGeo]) g.__shared = true;

  function makeInstanced(geo, mat, mats, depthMat = null) {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(mats.length, 1));
    mats.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.count = mats.length;
    mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false;
    mesh.castShadow = true; mesh.receiveShadow = true;
    if (depthMat) mesh.customDepthMaterial = depthMat;
    activeGroup.add(mesh);
    return mesh;
  }

  // real roads, draped over the terrain as gravel ribbons (one merged mesh).
  // Samples every ~12 m; runs break where the road would dip underwater
  // (the chart draws some islands smaller than the road network knows them).
  function buildRoadMesh(regionRoads) {
    const pos = [], col = [], idx = [];
    // pale sandy gravel — Finnish archipelago roads are light cuts that
    // read clearly against forest and granite, not asphalt-grey camouflage
    const cMajor = new THREE.Color(0xbfb090), cMinor = new THREE.Color(0xab9d80);
    for (const rd of regionRoads) {
      const hw = rd.c === 1 ? 2.6 : 1.7;
      const cc = rd.c === 1 ? cMajor : cMinor;
      // a road lives on one island (occasionally two) — probe only those,
      // not every island in the region, or draping costs seconds at Nauvo
      const hosts = activeSet.filter((i) =>
        rd.maxX > i.x + i.bbox.minX && rd.minX < i.x + i.bbox.maxX &&
        rd.maxZ > i.z + i.bbox.minZ && rd.minZ < i.z + i.bbox.maxZ);
      const hAt = (x, z) => {
        let m = -10;
        for (const i of hosts) {
          const lx = x - i.x, lz = z - i.z, b = i.bbox;
          if (lx < b.minX - 8 || lx > b.maxX + 8 || lz < b.minZ - 8 || lz > b.maxZ + 8) continue;
          const h = islandHeight(lx, lz, i);
          if (h > m) m = h;
        }
        return m;
      };
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          const base = pos.length / 3;
          for (let i = 0; i < run.length; i++) {
            const [x, y, z] = run[i];
            const a = run[Math.max(i - 1, 0)], b2 = run[Math.min(i + 1, run.length - 1)];
            let tx = b2[0] - a[0], tz = b2[2] - a[2];
            const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
            pos.push(x - tz * hw, y, z + tx * hw, x + tz * hw, y, z - tx * hw);
            col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
          }
          for (let i = 0; i < run.length - 1; i++) {
            const a = base + i * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
        run = [];
      };
      for (let i = 0; i < rd.p.length - 1; i++) {
        const [x1, z1] = rd.p[i], [x2, z2] = rd.p[i + 1];
        const segL = Math.hypot(x2 - x1, z2 - z1);
        const steps = Math.max(1, Math.round(segL / 12));
        for (let s2 = 0; s2 <= (i === rd.p.length - 2 ? steps : steps - 1); s2++) {
          const t = s2 / steps;
          const x = x1 + (x2 - x1) * t, z = z1 + (z2 - z1) * t;
          const y = hAt(x, z);
          if (y < 0.25) { flush(); continue; }
          run.push([x, y + 0.2, z]);
        }
      }
      flush();
    }
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, roadMat);
    mesh.receiveShadow = true;
    return mesh;
  }
  const roadMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.93, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  roadMat.__shared = true;

  // 8 m world-cell hash of the region's road lines — trees keep off the
  // carriageway (plus a verge), which is also what makes a road visible
  // from the water: a pale gravel cut through the forest
  const roadHash = new Set();
  const roadCell = (x, z) => Math.floor(x / 8) + ',' + Math.floor(z / 8);
  function hashRoads(regionRoads) {
    roadHash.clear();
    for (const rd of regionRoads) {
      for (let i = 0; i < rd.p.length - 1; i++) {
        const [x1, z1] = rd.p[i], [x2, z2] = rd.p[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / 7));
        for (let s = 0; s <= n; s++)
          roadHash.add(roadCell(x1 + (x2 - x1) * s / n, z1 + (z2 - z1) * s / n));
      }
    }
  }
  function nearRoad(x, z) {
    if (!roadHash.size) return false;
    const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
      if (roadHash.has((cx + dx) + ',' + (cz + dz))) return true;
    return false;
  }

  // ── TIME-SLICED region builds: the per-island geometry work (the expensive
  //    part — seconds in the dense Nauvo interior) is spread across frames
  //    while the OLD region stays on screen; the swap happens at finalize.
  //    A teleport burns a bigger first slice so it still feels immediate. ──
  let job = null;

  function rebuild(cx0, cz0) {
    perf.mesh = perf.color = perf.scatter = 0;
    geoParts = []; pineMats = []; birchMats = []; juniperMats = []; boulderMats = []; grassMats = []; slabMats = []; reedMats = [];
    treeBudget = 14000;                   // region-wide cap: near islands (sorted first) win
    grassBudget = 6000; slabBudget = 1300; reedBudget = 2200;
    activeCenter.set(cx0, cz0);
    if (satOn) satellite.update(cx0, cz0);   // stream the aerial photo for this region

    // islands whose bbox touches the build square, nearest first
    let set = [];
    for (const i of islands) {
      const dx = Math.max(Math.abs(i.x - cx0) - (i.bbox.maxX - i.bbox.minX) / 2, 0);
      const dz = Math.max(Math.abs(i.z - cz0) - (i.bbox.maxZ - i.bbox.minZ) / 2, 0);
      if (dx < RBUILD && dz < RBUILD) set.push(i);
    }
    // nearest first BY EDGE, not centroid — the big island whose shore you're
    // moored at must win the scatter budgets, not queue behind 50 skerries
    // because its centroid is kilometres inland
    const edge2 = (i) => {
      const dx = Math.max(i.x + i.bbox.minX - cx0, cx0 - (i.x + i.bbox.maxX), 0);
      const dz = Math.max(i.z + i.bbox.minZ - cz0, cz0 - (i.z + i.bbox.maxZ), 0);
      return dx * dx + dz * dz;
    };
    set.sort((a, b) => edge2(a) - edge2(b));
    if (set.length > MAX_ISLANDS) set = set.slice(0, MAX_ISLANDS);

    for (const isl of set) {
      // real land cover intersecting this island (world-coord polygons w/ bbox)
      isl._wood = []; isl._heath = []; isl._scrub = [];
      const bx0 = isl.x + isl.bbox.minX, bx1 = isl.x + isl.bbox.maxX;
      const bz0 = isl.z + isl.bbox.minZ, bz1 = isl.z + isl.bbox.maxZ;
      for (const n of nature) {
        if (n.maxX < bx0 || n.minX > bx1 || n.maxZ < bz0 || n.minZ > bz1) continue;
        if (n.c === 0) isl._wood.push(n);
        else if (n.c === 1) isl._heath.push(n);
        else if (n.c === 2) isl._scrub.push(n);
      }
    }
    // roads intersecting the region — needed BEFORE island scatter so trees
    // keep off the carriageways. Nearest-first, capped, like everything else.
    const regionRoads = roads
      .filter((r) => r.maxX > cx0 - RBUILD && r.minX < cx0 + RBUILD && r.maxZ > cz0 - RBUILD && r.minZ < cz0 + RBUILD)
      .sort((a, b) => (((a.minX + a.maxX) / 2 - cx0) ** 2 + ((a.minZ + a.maxZ) / 2 - cz0) ** 2)
                    - (((b.minX + b.maxX) / 2 - cx0) ** 2 + ((b.minZ + b.maxZ) / 2 - cz0) ** 2))
      .slice(0, 260);
    hashRoads(regionRoads);

    job = { set, i: 0, cx0, cz0, t0: performance.now(), regionRoads };
    stepRebuild(40);                      // a generous first slice: teleports feel instant
  }

  function stepRebuild(budgetMs = 7) {
    if (!job) return;
    const tS = performance.now();
    while (job.i < job.set.length && performance.now() - tS < budgetMs) {
      buildIsland(job.set[job.i++]);
    }
    if (job.i >= job.set.length) finalizeRebuild();
  }

  function finalizeRebuild() {
    const { set, cx0, cz0, t0, regionRoads } = job;
    job = null;
    disposeActive();                      // the old region leaves only now
    activeSet = set;
    landmark = null;

    // one merged mesh for the whole region → a single draw call
    if (geoParts.length) {
      const merged = BufferGeometryUtils.mergeGeometries(geoParts, false);
      const mesh = new THREE.Mesh(merged, islandMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      activeGroup.add(mesh);
    }
    makeInstanced(pineGeo.trunk, trunkMat, pineMats);
    makeInstanced(pineGeo.canopy, pineMat, pineMats, depthNeedle);
    makeInstanced(birchGeo.trunk, trunkMat, birchMats);
    makeInstanced(birchGeo.canopy, birchMat, birchMats, depthLeaf);
    makeInstanced(juniperGeo, juniperMat, juniperMats, depthLeaf);
    makeInstanced(boulderGeo, boulderMat, boulderMats);
    makeInstanced(slabGeo, boulderMat, slabMats);
    const grassMesh = makeInstanced(grassGeo, grassMat, grassMats);
    grassMesh.castShadow = false;
    const reedMesh = makeInstanced(reedGeo, reedMat, reedMats);
    reedMesh.castShadow = false;                     // tufts shade nothing; saves the shadow pass

    // the REAL Utö: Finland's oldest lighthouse + pilot village — when in range
    const uto = activeSet.find((i) => i.name === 'Utö');
    if (uto) {
      const hrng = mulberry32(123);
      let bx = 0, bz = 0, by = islandHeight(0, 0, uto);
      for (let n = 0; n < 80; n++) {
        const lx = uto.bbox.minX + hrng() * (uto.bbox.maxX - uto.bbox.minX);
        const lz = uto.bbox.minZ + hrng() * (uto.bbox.maxZ - uto.bbox.minZ);
        const y = islandHeight(lx, lz, uto);
        if (y > by) { by = y; bx = lx; bz = lz; }
      }
      const tower = buildLighthouse();
      tower.position.set(uto.x + bx, by - 0.4, uto.z + bz);
      tower.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
      activeGroup.add(tower);
      landmark = tower.userData;
      // (the village is now the REAL one, placed from OSM building footprints)
    }

    // floating name labels for the region's major islands
    const named = activeSet.filter((i) => i.name).sort((a, b) => b.A - a.A).slice(0, 12);
    for (const isl of named) {
      const spr = nameSprite(isl.name);
      spr.position.set(isl.x, isl.H + 14, isl.z);
      activeGroup.add(spr);
    }

    // life: buoys marking channels, harbours, cottages, traffic, gulls, Utö extras
    const RB = RBUILD;
    const inBox = (x, z) => Math.abs(x - cx0) < RB && Math.abs(z - cz0) < RB;
    // roads were selected up-front in rebuild() (the scatter needed them);
    // here they become the terrain ribbons + the cars' routes
    const roadMesh = buildRoadMesh(regionRoads);
    if (roadMesh) activeGroup.add(roadMesh);

    const region = {
      buildings: (realData?.buildings || []).filter((b) => inBox(b[0], b[1])),
      piers: (realData?.piers || []).filter((pl) => inBox(pl[0][0], pl[0][1])),
      seamarks: (realData?.seamarks || []).filter((m) => inBox(m[0], m[1])),
      roads: regionRoads,
    };
    propsRef = buildProps({ activeSet, islandHeight, heightAt, center: activeCenter, region });
    activeGroup.add(propsRef.group);

    // what in this region is measured data vs procedural — feeds the D overlay
    const cover = new Set();
    let measured = 0, gridded = 0, coverCounts = { wood: 0, heath: 0, scrub: 0 };
    for (const isl of activeSet) {
      if (isl.realElev) measured++;
      if (isl.grid) gridded++;
      for (const [list, key] of [[isl._wood, 'wood'], [isl._heath, 'heath'], [isl._scrub, 'scrub']]) {
        for (const n of list) if (!cover.has(n)) { cover.add(n); coverCounts[key]++; }
      }
    }
    // rendered counts are capped (props.js) — carry the region's TRUE totals too,
    // so the data panel never passes a render cap off as the amount of real data
    lastCounts = {
      islands: activeSet.length, measured, gridded, ...coverCounts, ...propsRef.counts,
      buildingsTotal: region.buildings.length,
      pierSegsTotal: region.piers.reduce((a, l) => a + Math.max(l.length - 1, 0), 0),
      seamarksTotal: region.seamarks.length,
    };
    debugGroup = null;                    // the old overlay died with disposeActive
    if (debugOn) buildDebugOverlay();
    console.debug(`[rebuild] ${(performance.now() - t0).toFixed(0)}ms sliced — mesh ${perf.mesh.toFixed(0)} · color ${perf.color.toFixed(0)} · scatter ${perf.scatter.toFixed(0)} · islands ${activeSet.length}`);
  }

  // flush any in-flight region build synchronously (dev hooks want it done)
  function rebuildSync(cx0, cz0) {
    rebuild(cx0, cz0);
    while (job) stepRebuild(1e9);
  }

  // max terrain height at a world point — used for boat↔island collision.
  // Uses the active region when built (the boat is always inside it).
  function heightAt(x, z) {
    let m = -10;
    const pool = activeSet.length ? activeSet : islands;
    for (const i of pool) {
      const lx = x - i.x, lz = z - i.z;
      const b = i.bbox;
      if (lx < b.minX - 8 || lx > b.maxX + 8 || lz < b.minZ - 8 || lz > b.maxZ + 8) continue;
      const h = islandHeight(lx, lz, i);
      if (h > m) m = h;
    }
    return m;
  }

  const _inv = new THREE.Matrix4();
  function update(dt, t, camera, sunDir) {
    stepRebuild();                        // a slice of any in-flight region build
    camera.updateMatrixWorld();
    _inv.copy(camera.matrixWorld).invert();
    sunViewDir.copy(sunDir).transformDirection(_inv);
    for (const sh of shaders) if (sh.uniforms.uTime) sh.uniforms.uTime.value = t;
    // ease the aerial drape in as tiles arrive; fall to granite when toggled off
    const satTarget = (satOn && satellite.ready) ? 0.92 : 0;
    satBlend += (satTarget - satBlend) * (1 - Math.exp(-3 * dt));
    for (const sh of islandShaders) {
      if (sh.uniforms.uTime) sh.uniforms.uTime.value = t;
      if (sh.uniforms.uSatOn) sh.uniforms.uSatOn.value = satBlend;
    }
    if (propsRef) propsRef.update(dt, t, env.waveHeightAt);
    // Utö light: four short flashes (Morse "H") then a pause, plus a slow sweeping beam
    if (landmark) {
      const c = t % 5.0; let on = 0;
      for (let f = 0; f < 4; f++) if (c >= f * 0.5 && c < f * 0.5 + 0.22) on = 1;
      landmark.core.material.emissiveIntensity = 1.2 + on * 6.5;
      landmark.pl.intensity = 0.4 + on * 4.5;
      landmark.glow.material.opacity = 0.18 + on * 0.78;
      if (landmark.beamPivot) {
        landmark.beamPivot.rotation.y = t * 0.55;
        const op = 0.12 + on * 0.16;   // continuously visible sweep, brighter on each flash
        for (const m of landmark.beamMats) m.uniforms.uOpacity.value = op;
      }
    }
  }

  function toggleSatellite() {
    satOn = !satOn;
    if (satOn) satellite.update(activeCenter.x, activeCenter.y);
    return satOn;
  }

  return {
    group, update, islands, heightAt, islandHeight, rebuild, rebuildSync, setDebug, toggleSatellite,
    get debugOn() { return debugOn; },
    get debugInfo() { return lastCounts; },
    get satOn() { return satOn; },
    get activeCenter() { return activeCenter; },
  };
}

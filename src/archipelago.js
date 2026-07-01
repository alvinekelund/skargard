import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise2D, makeFbm, mulberry32 } from './noise.js';

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

// signed distance to the island polygon: >0 inside (metres from shore), <0 at sea
function polySdf(lx, lz, ring) {
  let inside = false, d2 = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    const dx = xj - xi, dz = zj - zi;
    const L2 = dx * dx + dz * dz || 1e-9;
    let t = ((lx - xi) * dx + (lz - zi) * dz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = xi + t * dx - lx, pz = zi + t * dz - lz;
    const dd = px * px + pz * pz;
    if (dd < d2) d2 = dd;
    if (((zi > lz) !== (zj > lz)) && (lx < (xj - xi) * (lz - zi) / (zj - zi) + xi)) inside = !inside;
  }
  const d = Math.sqrt(d2);
  return inside ? d : -d;
}

// height from the real shoreline: distance-from-shore rises to a smooth glaciated
// whaleback crown; height/rise-length scale with island size and kind
function islandHeight(lx, lz, isl) {
  const b = isl.bbox;
  if (lx < b.minX - 24 || lx > b.maxX + 24 || lz < b.minZ - 24 || lz > b.maxZ + 24) return -8;
  const s = polySdf(lx, lz, isl.ring);
  if (s <= 0) return Math.max(s * 0.55, -8.0) - 0.05;      // gentle submerged apron
  const dome = Math.pow(THREE.MathUtils.smoothstep(s, 0, isl.S), 0.62);
  const cx = isl.x, cz = isl.z;
  let h = dome * isl.H;
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

export function buildArchipelago(scene, env, mapData) {
  const group = new THREE.Group();
  scene.add(group);
  const shaders = [];
  const sunViewDir = new THREE.Vector3();

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
  const rockD = texLoader.load('/rock_diff.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; });
  const rockN = texLoader.load('/rock_nor.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; });
  const rockR = texLoader.load('/rock_rough.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; });

  const islandShaders = [];
  const islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0, envMapIntensity: 0.4 });
  islandMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uRockD = { value: rockD };
    sh.uniforms.uRockN = { value: rockN };
    sh.uniforms.uRockR = { value: rockR };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWPos = worldPosition.xyz;')
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n vWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform sampler2D uRockD, uRockN, uRockR;
        varying vec3 vWPos; varying vec3 vWNrm;
        vec3 triW() { vec3 w = pow(abs(vWNrm), vec3(4.0)); return w / (w.x + w.y + w.z); }
        vec4 triSample(sampler2D t, float s) {
          vec3 w = triW();
          return texture2D(t, vWPos.zy * s) * w.x
               + texture2D(t, vWPos.xz * s) * w.y
               + texture2D(t, vWPos.xy * s) * w.z;
        }`)
      // albedo: two-scale rock detail (noise-masked so contrast survives) modulates
      // the ecological vertex tint; mean-normalised so tints keep their value
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 texA = triSample(uRockD, 0.16).rgb;
          vec3 texB = triSample(uRockD, 0.047).rgb;
          float m = smoothstep(-0.3, 0.3, sin(vWPos.x * 0.37) * sin(vWPos.z * 0.29));
          vec3 tex = mix(texA, texB, m * 0.6 + 0.2);
          vec3 detail = clamp(tex / vec3(0.22, 0.21, 0.20), 0.35, 1.9);
          diffuseColor.rgb *= mix(vec3(1.0), detail, 0.85);
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
  const pineGeo = pineGeometry(mulberry32(1));
  const birchGeo = birchGeometry(mulberry32(2));
  const juniperGeo = juniperGeometry(mulberry32(3));
  const boulderGeo = boulderGeometry(mulberry32(4));
  const boulderMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.4 });
  const pineMats = [], birchMats = [], juniperMats = [], boulderMats = [];
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0,1,0);

  // ── islands from the REAL chart: every polygon is an actual island outline
  //    from OSM (Utö–Jurmo region, Archipelago Sea), uniformly compressed. ──
  const rng = mulberry32(20260613);
  const islands = [];
  for (const rec of (mapData ? mapData.islands : [])) {
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
    const A = rec.a, kind = rec.k;
    const lg = Math.log10(Math.max(A / 300, 1));
    const H = kind === 'bald' ? 0.7 + 0.4 * lg : kind === 'sparse' ? 1.2 + 1.2 * lg : 2.2 + 1.6 * lg;
    islands.push({
      x: cx, z: cz, ring, bbox: { minX, minZ, maxX, maxZ },
      A, R: Math.sqrt(A / Math.PI), H,
      S: THREE.MathUtils.clamp(Math.sqrt(A) * 0.14, 4, 30),
      kind, name: rec.n || null,
    });
  }

  const geoParts = [];
  for (const isl of islands) buildIsland(isl);

  function buildIsland(isl) {
    const { x: cx, z: cz, bbox, H, kind } = isl;
    const M = 14;                                     // underwater apron margin
    const w = bbox.maxX - bbox.minX + M * 2, d = bbox.maxZ - bbox.minZ + M * 2;
    const segX = THREE.MathUtils.clamp(Math.round(w * 0.85), 10, 190);
    const segZ = THREE.MathUtils.clamp(Math.round(d * 0.85), 10, 190);
    const geo = new THREE.PlaneGeometry(w, d, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const ox = (bbox.minX + bbox.maxX) / 2, oz = (bbox.minZ + bbox.maxZ) / 2;
    geo.translate(ox, 0, oz);                         // grid over the polygon's bbox
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, islandHeight(pos.getX(i), pos.getZ(i), isl));
    geo.computeVertexNormals();

    const nrm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const tmp = new THREE.Color();
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
        const streak = fbm((lx + cx) * 0.3, (lz + cz) * 0.04, 2) * 0.5 + 0.5; // glaciated striae
        tmp.copy(COL.granite).lerp(COL.pink, grain * 0.6);
        tmp.lerp(COL.grey, THREE.MathUtils.smoothstep(streak, 0.55, 0.85) * 0.45);
        tmp.lerp(COL.lichen, THREE.MathUtils.smoothstep(patch, 0.62, 0.88) * THREE.MathUtils.clamp(slope, 0, 1) * 0.4);
        // heather + juniper heath carpets the flatter ground — the Jurmo signature
        const heathMask = THREE.MathUtils.smoothstep(slope, 0.72, 0.94) * THREE.MathUtils.smoothstep(y, 0.28, 1.1) * (0.55 + patch * 0.45);
        const bloom = fbm((lx + cx) * 0.22, (lz + cz) * 0.22, 3) * 0.5 + 0.5;
        const heath = COL.heathG.clone()
          .lerp(COL.heathBr, THREE.MathUtils.smoothstep(bloom, 0.32, 0.58))
          .lerp(COL.heather, THREE.MathUtils.smoothstep(bloom, 0.58, 0.86));
        tmp.lerp(heath, heathMask * 0.92);
      }
      tmp.offsetHSL(0, 0, (grain - 0.5) * 0.05);
      colors[i*3]=tmp.r; colors[i*3+1]=tmp.g; colors[i*3+2]=tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.translate(cx, 0, cz);                          // into world space for the merge
    geoParts.push(geo);

    const treeRng = mulberry32(Math.floor((cx + 9999) * 53 + (cz + 9999) * 131));
    const bw = bbox.maxX - bbox.minX, bd = bbox.maxZ - bbox.minZ;
    const samp = () => [bbox.minX + treeRng() * bw, bbox.minZ + treeRng() * bd];

    // ONLY proper forested islands carry trees. Small skerries are bare granite
    // with at most a little juniper scrub — never trees (that's the un-Finnish tell).
    if (kind === 'forest') {
      const target = Math.min(Math.floor(isl.A * 0.03), 420);
      let placed = 0, tries = 0;
      while (placed < target && tries < target * 14) {
        tries++;
        const [lx, lz] = samp();
        const y = islandHeight(lx, lz, isl);
        if (y < 0.9 || y > H + 1.0) continue;
        const e = 0.6;
        const dy = Math.hypot(
          islandHeight(lx+e,lz,isl) - islandHeight(lx-e,lz,isl),
          islandHeight(lx,lz+e,isl) - islandHeight(lx,lz-e,isl)) / (2*e);
        if (dy > 1.0 && treeRng() > 0.3) continue;
        const isBirch = treeRng() < 0.18;     // pine/spruce dominant, birch the accent
        const sc = (isBirch ? 0.8 : 0.7) + treeRng() * (isBirch ? 0.7 : 1.5);
        _p.set(cx + lx, y - 0.15, cz + lz);
        _s.set(sc * (0.85 + treeRng() * 0.3), sc, sc * (0.85 + treeRng() * 0.3));
        _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
        _m.compose(_p, _q, _s);
        (isBirch ? birchMats : pineMats).push(_m.clone());
        placed++;
      }
    }

    // low juniper + heather scrub — the heath that carpets these islands
    const jtarget = Math.min(Math.floor(isl.A * (kind === 'bald' ? 0.011 : kind === 'sparse' ? 0.02 : 0.008)), 240);
    let jp = 0, jt = 0;
    while (jp < jtarget && jt < jtarget * 12) {
      jt++;
      const [lx, lz] = samp();
      const y = islandHeight(lx, lz, isl);
      if (y < 0.3 || y > H + 0.4) continue;
      const sc = 0.7 + treeRng() * 1.1;
      _p.set(cx + lx, y - 0.06, cz + lz);
      _s.set(sc, sc * (0.7 + treeRng() * 0.5), sc);
      _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
      _m.compose(_p, _q, _s);
      juniperMats.push(_m.clone());
      jp++;
    }

    // scattered moraine boulders (Jurmo's "stone kingdom") on the bare rocks
    const btarget = Math.min(Math.floor(isl.A * (kind === 'forest' ? 0.003 : 0.008)), 160);
    let bp = 0, bt = 0;
    while (bp < btarget && bt < btarget * 12) {
      bt++;
      const [lx, lz] = samp();
      const y = islandHeight(lx, lz, isl);
      if (y < 0.15 || y > H + 0.3) continue;
      const sc = 0.5 + treeRng() * 1.6;
      _p.set(cx + lx, y - 0.1, cz + lz);
      _s.set(sc * (0.8 + treeRng() * 0.5), sc * (0.6 + treeRng() * 0.4), sc * (0.8 + treeRng() * 0.5));
      _q.setFromAxisAngle(_up, treeRng() * Math.PI * 2);
      _m.compose(_p, _q, _s);
      boulderMats.push(_m.clone());
      bp++;
    }
  }

  // one merged mesh for all 550+ islands → a single draw call (plus one shadow pass)
  {
    const merged = BufferGeometryUtils.mergeGeometries(geoParts, false);
    const mesh = new THREE.Mesh(merged, islandMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  }

  // instanced vegetation — trunk + canopy pairs share the same matrices; alpha-tested
  // canopies need a matching depth material so their shadows are needle-shaped too
  function makeInstanced(geo, mat, mats, { cast = true, alphaMap = null, alphaTest = 0 } = {}) {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(mats.length, 1));
    mats.forEach((m, i) => mesh.setMatrixAt(i, m)); mesh.count = mats.length;
    mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false;
    mesh.castShadow = cast; mesh.receiveShadow = true;
    if (alphaMap) mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: alphaMap, alphaTest });
    group.add(mesh);
    return mesh;
  }
  makeInstanced(pineGeo.trunk, trunkMat, pineMats);
  makeInstanced(pineGeo.canopy, pineMat, pineMats, { alphaMap: needleTex, alphaTest: 0.45 });
  makeInstanced(birchGeo.trunk, trunkMat, birchMats);
  makeInstanced(birchGeo.canopy, birchMat, birchMats, { alphaMap: leafTex, alphaTest: 0.4 });
  makeInstanced(juniperGeo, juniperMat, juniperMats, { alphaMap: leafTex, alphaTest: 0.35 });
  makeInstanced(boulderGeo, boulderMat, boulderMats);

  // ── the REAL Utö: Finland's oldest lighthouse + its pilot village, on the
  //    actual Utö island from the chart ──
  let landmark = null;
  const uto = islands.find((i) => i.name === 'Utö') || islands.find((i) => i.kind !== 'bald');
  if (uto) {
    // put the tower on the island's high ground
    const hrng = mulberry32(123);
    let bx = 0, bz = 0, by = islandHeight(0, 0, uto);
    for (let n = 0; n < 60; n++) {
      const lx = uto.bbox.minX + hrng() * (uto.bbox.maxX - uto.bbox.minX);
      const lz = uto.bbox.minZ + hrng() * (uto.bbox.maxZ - uto.bbox.minZ);
      const y = islandHeight(lx, lz, uto);
      if (y > by) { by = y; bx = lx; bz = lz; }
    }
    const tower = buildLighthouse();
    tower.position.set(uto.x + bx, by - 0.4, uto.z + bz);
    tower.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(tower);
    landmark = tower.userData;
    let houses = 0;
    for (let n = 0; n < 90 && houses < 8; n++) {
      const lx = uto.bbox.minX + hrng() * (uto.bbox.maxX - uto.bbox.minX);
      const lz = uto.bbox.minZ + hrng() * (uto.bbox.maxZ - uto.bbox.minZ);
      const hy = islandHeight(lx, lz, uto);
      if (hy < 0.8 || Math.hypot(lx - bx, lz - bz) > 90) continue;
      const house = buildHouse(hrng);
      house.position.set(uto.x + lx, hy - 0.1, uto.z + lz);
      house.rotation.y = hrng() * Math.PI * 2;
      house.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      group.add(house);
      houses++;
    }
  }

  // floating name labels over the major islands (real chart names)
  const named = islands.filter((i) => i.name).sort((a, b) => b.A - a.A).slice(0, 10);
  for (const isl of named) {
    const spr = nameSprite(isl.name);
    spr.position.set(isl.x, isl.H + 11, isl.z);
    group.add(spr);
  }

  // max terrain height at a world point — used for boat↔island collision
  function heightAt(x, z) {
    let m = -10;
    for (const i of islands) {
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
    camera.updateMatrixWorld();
    _inv.copy(camera.matrixWorld).invert();
    sunViewDir.copy(sunDir).transformDirection(_inv);
    for (const sh of shaders) if (sh.uniforms.uTime) sh.uniforms.uTime.value = t;
    for (const sh of islandShaders) if (sh.uniforms.uTime) sh.uniforms.uTime.value = t;
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

  return { group, update, islands, heightAt };
}

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { makeNoise2D, mulberry32 } from './noise.js';

/* Sky + sun + light + reflective sea + clouds + fog, with a bright-day and a
   golden-hour preset. Exposes a gentle wave-height field for boat buoyancy. */

export const PRESETS = {
  day: {
    sunElev: 38, sunAz: 205, turbidity: 1.8, rayleigh: 2.3, mie: 0.0035, g: 0.75, exposure: 0.33,
    sunColor: 0xfff3e0, sunInt: 5.6, hemiSky: 0x7fb2ff, hemiGround: 0x2e4f46, hemiInt: 0.6,
    ambient: 0x3a6ea5, ambientInt: 0.22, fog: 0xa9c6e0, fogDensity: 0.00022,
    waterColor: 0x2a544e, sunWater: 0xfff2d0, distortion: 3.4, waterSize: 2.8,
    cloudWarm: 0xfff8ee, cloudCool: 0xcfdcec, cloudCount: 11, cloudOpacity: 0.55, cloudElevHi: true,
    cloudSize: [800, 1500],
    bloom: { strength: 0.25, radius: 0.4, threshold: 1.1 },
  },
  golden: {
    // sun at 2.0° kisses the treeline: max path extinction = amber disc + rose band.
    // rayleigh 4.4 deepens the horizon rose AND the blue aloft; turbidity 4.2 gives
    // the warm mie glow-cone without whole-sky milk; g .87 keeps the halo tight.
    sunElev: 2.0, sunAz: 162, turbidity: 4.2, rayleigh: 4.4, mie: 0.0045, g: 0.87, exposure: 0.42,
    sunColor: 0xffa64d, sunInt: 3.2, hemiSky: 0x6c7fd8, hemiGround: 0x2e2a3e, hemiInt: 0.3,
    ambient: 0x4a3a66, ambientInt: 0.14, fog: 0xe08055, fogDensity: 0.0009,
    waterColor: 0x1c333a, sunWater: 0xffa050, distortion: 2.6, waterSize: 3.2,
    cloudWarm: 0xffa25e, cloudCool: 0x9d8bb8, cloudCount: 18, cloudOpacity: 0.65, cloudElevHi: false,
    cloudSize: [1800, 3600],
    // threshold >= 1.25: only true HDR (sun disc + glints) blooms, never the halo
    bloom: { strength: 0.18, radius: 0.55, threshold: 1.25 },
  },
};

// shared Gerstner sea for the INNER archipelago: short fetch between islands
// means chop, not ocean swell — the water is lively in texture but the level
// barely breathes (±0.3 m), so the shoreline never runs metres up the rocks
// and shore houses stay dry. Q keeps the crests visibly peaked. The SAME
// table is inlined into the water vertex shader and evaluated here in JS, so
// the mesh, the boat, the camera, and the wake all ride identical waves.
//              amp    λ     dir x   dir z   ω      Q
const WAVES = [
  [0.16, 90, 0.95, 0.32, 0.62, 6.0],
  [0.10, 46, -0.38, 0.92, 0.95, 7.0],
  [0.07, 18, 0.62, -0.79, 1.9, 9.0],
];
function horizDisp(x, z, t) {
  let hx = 0, hz = 0;
  for (const [a, L, dx, dz, w, q] of WAVES) {
    const th = (dx * x + dz * z) * (2 * Math.PI / L) + t * w;
    const qa = q * a * Math.cos(th);
    hx += qa * dx; hz += qa * dz;
  }
  return [hx, hz];
}
export function waveHeight(x, z, t) {
  // Gerstner surfaces displace horizontally too: one-step pull-back so the JS
  // height matches the displaced mesh to ~2 cm
  const [hx, hz] = horizDisp(x, z, t);
  const px = x - hx, pz = z - hz;
  let h = 0;
  for (const [a, L, dx, dz, w] of WAVES) {
    h += a * Math.sin((dx * px + dz * pz) * (2 * Math.PI / L) + t * w);
  }
  return h;
}
const WAVE_GLSL = WAVES.map(([a, L, dx, dz, w, q]) => {
  const k = (2 * Math.PI / L).toFixed(5);
  return `{
            float th = (${dx.toFixed(2)}*x + ${dz.toFixed(2)}*z) * ${k} + t * ${w.toFixed(2)};
            float ca = cos(th);
            d.x += ${(q * a).toFixed(3)} * ${dx.toFixed(2)} * ca;
            d.z += ${(q * a).toFixed(3)} * ${dz.toFixed(2)} * ca;
            d.y += ${a.toFixed(3)} * sin(th);
          }`;
}).join('\n          ');

function sunFromAngles(elevDeg, azDeg) {
  return new THREE.Vector3().setFromSphericalCoords(
    1, THREE.MathUtils.degToRad(90 - elevDeg), THREE.MathUtils.degToRad(azDeg));
}

function cloudTexture(seed) {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'); const img = ctx.createImageData(S, S);
  const n2 = makeNoise2D(seed);
  const fb = (x, y) => { let a = 0.5, f = 1, s = 0, nm = 0; for (let o = 0; o < 5; o++) { s += a * n2(x * f, y * f); nm += a; a *= 0.5; f *= 2; } return s / nm; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S, dx = u - 0.5, dy = (v - 0.5) * 1.7;
    const r = Math.sqrt(dx * dx + dy * dy) * 2.0;
    let d = fb(u * 3.4 + seed, v * 3.4) * 0.5 + 0.5;
    d *= Math.max(0, 1 - r); d = Math.max(0, d - 0.2) / 0.8;
    d = Math.pow(THREE.MathUtils.clamp(d, 0, 1), 1.4);
    const i = (y * S + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = (d * 255) | 0;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function createEnvironment(scene, renderer) {
  let preset = PRESETS.golden;
  let sunDir = sunFromAngles(preset.sunElev, preset.sunAz);

  scene.fog = new THREE.FogExp2(preset.fog, preset.fogDensity);

  const sky = new Sky(); sky.scale.setScalar(14000); scene.add(sky);
  const sunLight = new THREE.DirectionalLight(preset.sunColor, preset.sunInt);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  // ortho box sized to the visible sailing bubble; frustum long enough for a grazing sun
  const SB = 170;
  sunLight.shadow.camera.left = -SB; sunLight.shadow.camera.right = SB;
  sunLight.shadow.camera.top = SB; sunLight.shadow.camera.bottom = -SB;
  sunLight.shadow.camera.near = 50; sunLight.shadow.camera.far = 1600;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.06; // grazing-angle sun needs generous normal bias
  scene.add(sunLight, sunLight.target);
  const hemi = new THREE.HemisphereLight(preset.hemiSky, preset.hemiGround, preset.hemiInt);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(preset.ambient, preset.ambientInt);
  scene.add(ambient);

  // sea — a dense 3000 m tile (7 m vertex spacing so the 26 m wind-sea gets real
  // crests) that follows the boat, with a flat fog-blended horizon skirt beyond.
  const waterShaderRef = { sh: null };
  const waterNormals = new THREE.TextureLoader().load(import.meta.env.BASE_URL + 'waternormals.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; });
  const water = new Water(new THREE.PlaneGeometry(3000, 3000, 430, 430), {
    textureWidth: 1024, textureHeight: 1024, waterNormals,
    sunDirection: sunDir.clone(), sunColor: preset.sunWater, waterColor: preset.waterColor,
    distortionScale: preset.distortion, fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  water.material.uniforms.size.value = preset.waterSize;
  water.material.onBeforeCompile = (sh) => {
    sh.uniforms.uWaveTime = { value: 0 };
    waterShaderRef.sh = sh;
    // (1) true GERSTNER swell in the vertex shader — crests peak because the
    //     surface is displaced horizontally too. World-anchored as the tile moves.
    //     Plane local axes after the -90° X tilt: local x→world x, local y→world -z,
    //     local z→world y.
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWaveTime;
        vec3 waveDisp(float x, float z, float t){
          vec3 d = vec3(0.0);
          ${WAVE_GLSL}
          return d;
        }`)
      .replace('mirrorCoord = modelMatrix * vec4( position, 1.0 );', `
        vec3 gPos = position;
        vec4 _wp = modelMatrix * vec4( position, 1.0 );
        vec3 _wd = waveDisp(_wp.x, _wp.z, uWaveTime);
        gPos.x += _wd.x;
        gPos.y -= _wd.z;
        gPos.z += _wd.y;
        mirrorCoord = modelMatrix * vec4( gPos, 1.0 );`)
      .replace('vec4 mvPosition =  modelViewMatrix * vec4( position, 1.0 );',
        'vec4 mvPosition =  modelViewMatrix * vec4( gPos, 1.0 );');
    let f = sh.fragmentShader;
    // (2) capillary sparkle: analytic micro-ripple perturbs the normal in the
    //     fragment only — cheap grazing-light glitter that never enters buoyancy
    f = f.replace('uniform vec3 sunColor;', 'uniform vec3 sunColor;\n uniform float uWaveTime;');
    f = f.replace(
      'vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );',
      `vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );
       {
         vec2 wp = worldPosition.xz;
         surfaceNormal.xz += vec2(0.93, -0.38) * 0.10 * cos(dot(wp, vec2(0.93, -0.38)) * 0.9666 + uWaveTime * 3.1);
         surfaceNormal.xz += vec2(0.64, -0.77) * 0.085 * cos(dot(wp, vec2(0.64, -0.77)) * 2.1666 + uWaveTime * 4.6);
         surfaceNormal = normalize(surfaceNormal);
       }`);
    // (3) longer, more dramatic sunset glitter: wider specular lobe, a bit hotter
    f = f.replace(
      'sunLight( surfaceNormal, eyeDirection, 100.0, 2.0, 0.5, diffuseLight, specularLight );',
      'sunLight( surfaceNormal, eyeDirection, 55.0, 2.6, 0.5, diffuseLight, specularLight );');
    // (4) Baltic grade: boost body scatter, soften the mirror, desaturate toward
    //     a brackish grey-green (NOT Atlantic blue / turquoise).
    f = f.replace(
      'vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;',
      'vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor * 2.3;');
    f = f.replace(
      'float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );',
      'float reflectance = ( rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 ) ) * 0.62;');
    f = f.replace(
      'gl_FragColor = vec4( outgoingLight, alpha );',
      `float wl = dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) );
       vec3 wc = mix( vec3( wl ), outgoingLight, 1.05 ) * vec3( 0.93, 1.02, 0.95 );
       gl_FragColor = vec4( wc, alpha );`);
    sh.fragmentShader = f;
  };
  water.material.needsUpdate = true;
  scene.add(water);

  // flat horizon skirt out to the fog — same colour family as the sea body
  const skirt = new THREE.Mesh(
    new THREE.RingGeometry(1460, 8000, 64),
    new THREE.MeshBasicMaterial({ color: preset.waterColor, fog: true }),
  );
  skirt.rotation.x = -Math.PI / 2;
  skirt.position.y = -1.05;
  scene.add(skirt);

  // clouds
  const cloudTextures = [cloudTexture(11), cloudTexture(37), cloudTexture(91)];
  const cloudGroup = new THREE.Group();
  scene.add(cloudGroup);

  // PMREM env
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  function rebuildClouds() {
    while (cloudGroup.children.length) { const c = cloudGroup.children.pop(); c.material.dispose(); }
    const warm = new THREE.Color(preset.cloudWarm), cool = new THREE.Color(preset.cloudCool);
    const crng = mulberry32(5);
    for (let i = 0; i < preset.cloudCount; i++) {
      const mat = new THREE.SpriteMaterial({ map: cloudTextures[i % 3], transparent: true, depthWrite: false, fog: false });
      const spr = new THREE.Sprite(mat);
      const az = THREE.MathUtils.degToRad(preset.sunAz) + (crng() - 0.5) * Math.PI * 1.7;
      const elev = THREE.MathUtils.degToRad((preset.cloudElevHi ? 10 : 3) + crng() * (preset.cloudElevHi ? 42 : 32));
      const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elev, az);
      spr.position.copy(dir).multiplyScalar(3000 + crng() * 3000);
      const sunAmt = Math.pow(THREE.MathUtils.clamp(dir.dot(sunDir), 0, 1), 1.6);
      mat.color.copy(cool).lerp(warm, sunAmt);
      mat.opacity = preset.cloudOpacity * (0.5 + 0.5 * crng());
      const [w0, w1] = preset.cloudSize || [1500, 2700];
      const w = w0 + crng() * (w1 - w0); spr.scale.set(w, w * (0.32 + crng() * 0.18), 1);
      cloudGroup.add(spr);
    }
  }

  function bakeEnv() {
    const envScene = new THREE.Scene();
    const s = new Sky(); s.scale.setScalar(10000);
    const u = s.material.uniforms;
    u.turbidity.value = preset.turbidity; u.rayleigh.value = preset.rayleigh;
    u.mieCoefficient.value = preset.mie; u.mieDirectionalG.value = preset.g;
    u.sunPosition.value.copy(sunDir);
    envScene.add(s);
    if (envRT) envRT.dispose();
    envRT = pmrem.fromScene(envScene);
    scene.environment = envRT.texture;
  }

  function apply() {
    sunDir = sunFromAngles(preset.sunElev, preset.sunAz);
    const u = sky.material.uniforms;
    u.turbidity.value = preset.turbidity; u.rayleigh.value = preset.rayleigh;
    u.mieCoefficient.value = preset.mie; u.mieDirectionalG.value = preset.g;
    u.sunPosition.value.copy(sunDir);

    sunLight.color.set(preset.sunColor); sunLight.intensity = preset.sunInt;
    sunLight.position.copy(sunDir).multiplyScalar(900);
    hemi.color.set(preset.hemiSky); hemi.groundColor.set(preset.hemiGround); hemi.intensity = preset.hemiInt;
    ambient.color.set(preset.ambient); ambient.intensity = preset.ambientInt;
    scene.fog.color.set(preset.fog); scene.fog.density = preset.fogDensity;
    renderer.setClearColor(new THREE.Color(preset.fog), 1);
    renderer.toneMappingExposure = preset.exposure;

    water.material.uniforms.sunDirection.value.copy(sunDir);
    water.material.uniforms.sunColor.value.set(preset.sunWater);
    water.material.uniforms.waterColor.value.set(preset.waterColor);
    water.material.uniforms.distortionScale.value = preset.distortion;
    skirt.material.color.set(preset.waterColor);
    water.material.uniforms.size.value = preset.waterSize;

    rebuildClouds();
    bakeEnv();
  }
  apply();

  function setPreset(name) { if (PRESETS[name]) { preset = PRESETS[name]; apply(); } }

  // the SAME swell the water mesh rides — used for buoyancy + chase-cam height
  function waveHeightAt(x, z, t) { return waveHeight(x, z, t); }

  function update(dt, t, follow) {
    water.material.uniforms.time.value += dt * (preset === PRESETS.golden ? 0.45 : 0.6);
    if (waterShaderRef.sh) waterShaderRef.sh.uniforms.uWaveTime.value = t;
    // keep the dense water tile centred on the player; waves are world-anchored
    if (follow) {
      water.position.x = follow.x; water.position.z = follow.z;
      skirt.position.x = follow.x; skirt.position.z = follow.z;
      // the sky dome and cloud band ride along too — the world is 60 km wide at 1:1
      sky.position.x = follow.x; sky.position.z = follow.z;
      cloudGroup.position.x = follow.x; cloudGroup.position.z = follow.z;
      // shadow frustum rides along with the boat so nearby land always has shadows
      sunLight.target.position.set(follow.x, 0, follow.z);
      sunLight.position.copy(sunDir).multiplyScalar(900).add(sunLight.target.position);
    }
    cloudGroup.rotation.y = t * 0.004;
  }

  return {
    update, setPreset, water, waveHeightAt,
    get sunDir() { return sunDir; },
    get presetName() { return preset === PRESETS.golden ? 'golden' : 'day'; },
  };
}

/* ───────────────────────────────────────────────────────────────────────────
   Skärgård — a good-feel sailing game in a Finnish archipelago.
   Helm a small sloop through a field of granite skerries: real points of sail,
   momentum, heel, wind, wake. Arrow keys to steer + trim, C for camera, T for
   time of day.
   ─────────────────────────────────────────────────────────────────────────── */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { createEnvironment, PRESETS } from './environment.js';
import { buildArchipelago } from './archipelago.js';
import { createBoat } from './boat.js';
import { createHUD } from './hud.js';
import { createAudio } from './audio.js';
import { createChart } from './map.js';
import { createGustField } from './wind.js';
import { createShips, ROUTES } from './ships.js';
import { createFleet } from './fleet.js';
import { HARBOR_POINTS } from './props.js';
import { createLandmarks } from './landmarks.js';

/* ── renderer / scene / camera ── */
const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.5, 16000);
camera.layers.enable(1);   // see the instanced trees/rocks (layer 1, kept off the water reflection)
camera.position.set(0, 12, 24);

/* ── world ── */
const env = createEnvironment(scene, renderer);
// the REAL Archipelago Sea: 550+ actual island outlines (OSM) around Utö–Jurmo
const mapData = await (await fetch(import.meta.env.BASE_URL + 'archipelago_map.json')).json();
// real buildings, piers, charted seamarks and land cover (OSM)
const realData = await (await fetch(import.meta.env.BASE_URL + 'archipelago_data.json')).json();
// satellite-classified land cover (forest/field/rock/heath per island) — optional
const coverData = await fetch(import.meta.env.BASE_URL + 'archipelago_cover.json')
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
// the real road network (OSM highways) — ribbons on the terrain, cars on them
const roadsData = await fetch(import.meta.env.BASE_URL + 'archipelago_roads.json')
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
const archipelago = buildArchipelago(scene, env, mapData, realData, coverData, roadsData);
const boat = createBoat(scene);

// spawn in open water off Utö, bow pointed toward Jurmo, and stream that region in
{
  const uto = archipelago.islands.find((i) => i.name === 'Utö');
  const jurmo = archipelago.islands.find((i) => i.name === 'Jurmo');
  if (uto) {
    let sx = uto.x + uto.bbox.maxX + 120, sz = uto.z;
    for (let n = 0; n < 40 && archipelago.heightAt(sx, sz) > -1.2; n++) sx += 40;
    boat.state.pos.set(sx, 0, sz);
    boat.state.heading = jurmo ? Math.atan2(jurmo.x - sx, jurmo.z - sz) : Math.PI;
  }
  archipelago.rebuild(boat.state.pos.x, boat.state.pos.z);
}

// ship traffic on its real routes: Viking + Silja on the Turku–Åland fairway,
// the yellow road ferry, and the Utö-line connection vessel
// berth-side probe over the FULL island pool — heightAt only sees the streamed
// region, and the Helsinki terminals aren't in it at spawn
const globalHeightAt = (x, z) => {
  let m = -10;
  for (const i of archipelago.islands) {
    const lx = x - i.x, lz = z - i.z, b = i.bbox;
    if (lx < b.minX - 8 || lx > b.maxX + 8 || lz < b.minZ - 8 || lz > b.maxZ + 8) continue;
    const h = archipelago.islandHeight(lx, lz, i);
    if (h > m) m = h;
  }
  return m;
};
const ships = createShips(scene, globalHeightAt);

// ambient summer traffic that follows the helm — sloops actually sailing
// (heeled, real sail shapes) + motor cruisers, all keeping off the rock
const fleet = createFleet(scene, { heightAt: archipelago.heightAt });

// recognisable city landmarks (Helsinki + Turku cathedrals) at real coordinates
createLandmarks(scene);

/* ── the chart (M): pan/zoom the whole real Archipelago Sea, click to sail there ── */
const chart = createChart(mapData, {
  getBoat: () => boat.state,
  getShips: () => ships.markers(),
  realData, roadsData, routes: ROUTES,
  onTeleport: (x, z) => {
    boat.state.pos.set(x, 0, z);
    boat.state.speed = Math.min(boat.state.speed, 1);
    archipelago.rebuild(x, z);
  },
});

/* ── wind (blows TOWARD windDir; slowly shifts; gusts ride on top) ──
   base heading chosen off the spawn course so she starts on a beam reach, drawing */
const wind = { dir: new THREE.Vector3(), speed: 0.8, baseHeading: boat.state.heading - Math.PI * 0.55, gust: 0 };
wind.dir.set(Math.sin(wind.baseHeading), 0, Math.cos(wind.baseHeading)).normalize();
boat.state.speed = 1.6;
const gusts = createGustField(1337);
const shake = { t: 9, amp: 0 };
function triggerShake(a) { shake.t = 0; shake.amp = a; }

/* ── audio (starts on first interaction, per autoplay policy) ── */
const audio = createAudio();
const startAudio = () => audio.start();
addEventListener('keydown', startAudio, { once: true });
addEventListener('pointerdown', startAudio, { once: true });

/* ── input ── */
const input = { left: false, right: false, sheetIn: false, sheetOut: false };
const keymap = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'sheetIn', KeyW: 'sheetIn', ArrowDown: 'sheetOut', KeyS: 'sheetOut',
};
addEventListener('keydown', (e) => {
  if (keymap[e.code]) { input[keymap[e.code]] = true; e.preventDefault(); }
  if (e.code === 'KeyC') cycleCamera();
  if (e.code === 'KeyT') { env.setPreset(env.presetName === 'day' ? 'golden' : 'day'); applyBloom(); }
  if (e.code === 'KeyM') chart.toggle();
  if (e.code === 'KeyI') hud.setDebug(archipelago.setDebug(!archipelago.debugOn));
  if (e.code === 'KeyV') archipelago.toggleSatellite();
  if (e.code === 'KeyE') {
    boat.state.motorOn = !boat.state.motorOn;
    if (!boat.state.motorOn) boat.state.throttle = 0;
  }
});
addEventListener('keyup', (e) => { if (keymap[e.code]) { input[keymap[e.code]] = false; e.preventDefault(); } });

/* ── camera rig: smooth chase, with an orbit mode on C ── */
let camMode = 'pov';
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true; orbit.dampingFactor = 0.06; orbit.enablePan = false;
orbit.minDistance = 10; orbit.maxDistance = 70; orbit.maxPolarAngle = Math.PI * 0.49;
orbit.enabled = false;
const CAM_MODES = ['chase', 'pov', 'orbit'];
function cycleCamera() {
  const i = CAM_MODES.indexOf(camMode);
  camMode = CAM_MODES[(i + 1) % CAM_MODES.length];
  orbit.enabled = camMode === 'orbit';
  if (camMode !== 'pov') camera.up.set(0, 1, 0); // restore world-up for chase/orbit
}
const camPos = new THREE.Vector3(0, 12, 24);
const camLook = new THREE.Vector3();
const _fwd = new THREE.Vector3();
function expLerp(cur, target, k, dt) { return cur + (target - cur) * (1 - Math.exp(-k * dt)); }

function updateChase(dt) {
  const s = boat.state;
  _fwd.set(Math.sin(s.heading), 0, Math.cos(s.heading));
  const dist = 17, height = 7.5, ahead = 8;
  const tx = s.pos.x - _fwd.x * dist, tz = s.pos.z - _fwd.z * dist;
  const ty = (env.waveHeightAt(s.pos.x, s.pos.z, perfT) || 0) + height;
  camPos.x = expLerp(camPos.x, tx, 2.6, dt);
  camPos.y = expLerp(camPos.y, ty, 2.6, dt);
  camPos.z = expLerp(camPos.z, tz, 2.6, dt);
  const lx = s.pos.x + _fwd.x * ahead, lz = s.pos.z + _fwd.z * ahead, ly = 2.0;
  camLook.x = expLerp(camLook.x, lx, 3.4, dt);
  camLook.y = expLerp(camLook.y, ly, 3.4, dt);
  camLook.z = expLerp(camLook.z, lz, 3.4, dt);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.rotateZ(-s.heel * 0.35); // lean into the heel
  const targetFov = 52 + THREE.MathUtils.clamp(s.speed * 1.4, 0, 12);
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-3 * dt));
  camera.updateProjectionMatrix();
}

// helm view: sit at the tiller in the aft cockpit and look forward down the
// whole boat — cockpit, trunk, mast and foredeck laid out ahead. The boat's
// heel/pitch/heave carry through, but the horizon is partly stabilised for comfort.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const _povPos = new THREE.Vector3(), _povLook = new THREE.Vector3(), _povUp = new THREE.Vector3();
function updatePOV(dt) {
  boat.group.updateMatrixWorld();
  _povPos.set(0, 1.62, -3.5); boat.group.localToWorld(_povPos);   // seated eye at the helm
  _povLook.set(0, 1.15, 9); boat.group.localToWorld(_povLook);    // forward down the deck, slightly down
  _povUp.set(0, 1, 0).applyQuaternion(boat.group.quaternion).lerp(WORLD_UP, 0.45).normalize();
  camera.position.copy(_povPos);
  camera.up.copy(_povUp);
  camera.lookAt(_povLook);
  const targetFov = 64;
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt));
  camera.updateProjectionMatrix();
}

/* ── post ── */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.55, 0.84);
composer.addPass(bloom);
// bloom sits BEFORE OutputPass, so its threshold reads LINEAR HDR values — the
// sky near the sun is far above 1.0 there. Threshold must be >= 1.0 or the whole
// sun quadrant blooms into a white wash. Tuned per preset.
function applyBloom() {
  const b = PRESETS[env.presetName].bloom;
  if (b) { bloom.strength = b.strength; bloom.radius = b.radius; bloom.threshold = b.threshold; }
}
applyBloom();
composer.addPass(new OutputPass());
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
  fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uTime;
    void main(){ vec3 c=texture2D(tDiffuse,vUv).rgb;
      c = mix(c, c*c*(3.0-2.0*c), 0.22);                          // filmic contrast
      float l=dot(c,vec3(0.2126,0.7152,0.0722));
      c += smoothstep(0.5,1.0,l)*vec3(0.04,0.014,-0.018);         // warm the highlights
      c += (1.0-l)*vec3(-0.006,0.0,0.014);                         // cool the shadows (teal-orange)
      c = mix(vec3(l), c, 1.18);                                   // richer saturation
      float d=distance(vUv,vec2(0.5)); c*=1.0-smoothstep(0.33,0.96,d)*0.36; // cinematic vignette
      float g=fract(sin(dot(vUv*(1.0+fract(uTime)),vec2(12.9898,78.233)))*43758.5453);
      c+=(g-0.5)*0.022; gl_FragColor=vec4(max(c,0.0),1.0); }`,
});
composer.addPass(grade);

addEventListener('resize', () => {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h); composer.setSize(w, h); bloom.setSize(w, h);
});

/* ── HUD ── */
const hud = createHUD();
hud.onMuteToggle = (m) => audio.setMuted(m);

// dev hook for inspection
window.__game = { boat, env, wind, input, camera, THREE, archipelago, chart, ships, bloom, grade, renderer, composer, setCamMode: (m) => { camMode = m; orbit.enabled = (m === 'orbit'); } };

/* ── loop ── */
const clock = new THREE.Clock();
let perfT = 0, firstFrame = true, lastLocCheck = -1;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  perfT = clock.getElapsedTime();

  // wind slowly shifts heading + breathes in strength
  // living wind: slow wander + breathing base + gust field (veer rides each puff)
  const G = gusts.update(perfT, dt);
  wind.baseHeading += Math.sin(perfT * 0.05) * 0.09 * dt;
  const gustHeading = wind.baseHeading + G.veer;
  wind.dir.set(Math.sin(gustHeading), 0, Math.cos(gustHeading)).normalize();
  const breathe = 0.78 + 0.18 * Math.sin(perfT * 0.13);
  wind.speed = Math.min(breathe * (1 + G.strength * G.env) * (1 + G.texture), 1.40);
  wind.gust = G.env;

  boat.update(dt, { input, windDir: wind.dir, windSpeed: wind.speed, gust: wind.gust, waveHeightAt: env.waveHeightAt, landHeightAt: archipelago.heightAt, time: perfT });
  if (boat.state.event) {
    triggerShake(boat.state.event.type === 'gybe' ? boat.state.event.mag : 0.25);
    boat.state.event = null;
  }
  archipelago.update(dt, perfT, camera, env.sunDir);
  ships.update(dt, perfT, env.waveHeightAt);
  fleet.update(dt, perfT, {
    playerPos: boat.state.pos, windHeading: gustHeading, windSpeed: wind.speed,
    waveHeightAt: env.waveHeightAt,
  });
  // stream the next region in as the boat sails on (brief hitch, ~every 1.2 km)
  {
    const c = archipelago.activeCenter;
    const ddx = boat.state.pos.x - c.x, ddz = boat.state.pos.z - c.y;
    if (ddx * ddx + ddz * ddz > 1200 * 1200) archipelago.rebuild(boat.state.pos.x, boat.state.pos.z);
  }
  env.update(dt, perfT, boat.state.pos);
  grade.uniforms.uTime.value = perfT;

  if (camMode === 'chase') updateChase(dt);
  else if (camMode === 'pov') updatePOV(dt);
  else if (camMode === 'orbit') { orbit.target.copy(boat.group.position); orbit.update(); }
  // 'free' → leave the camera wherever it was placed

  // boom-slam shake: a short decaying two-sine buzz, applied after the camera solve
  if (shake.t < 0.35) {
    shake.t += dt;
    const k = Math.exp(-shake.t * 9) * shake.amp;
    camera.rotation.z += 0.010 * k * Math.sin(shake.t * 55);
    camera.rotation.x += 0.006 * k * Math.sin(shake.t * 41 + 1.7);
    camera.position.y += 0.06 * k * Math.sin(shake.t * 33);
  }

  hud.update(boat.state, wind);
  // location readout: nearest named island (checked ~2x per second)
  if ((perfT - lastLocCheck) > 0.5) {
    lastLocCheck = perfT;
    let best = null, bd = 1e9;
    for (const i of archipelago.islands) {
      if (!i.name) continue;
      const d = Math.hypot(i.x - boat.state.pos.x, i.z - boat.state.pos.z) - i.R;
      if (d < bd) { bd = d; best = i; }
    }
    hud.setLocation(best && bd < 900 ? (bd < 90 ? best.name : 'near ' + best.name) : 'open sea');
    if (archipelago.debugOn) hud.setDebug(archipelago.debugInfo);   // counts follow the streamed region
    chart.tick();   // live ships on the minimap, or the open chart

    // soundscape context (twice a second): how close is the shore, and a guest
    // harbour? feed the shore wash, the halyard chorus, the diesel throb.
    const bx = boat.state.pos.x, bz = boat.state.pos.z;
    let hi = -10, wooded = 0;
    for (const [ox, oz] of [[0, 0], [35, 0], [-35, 0], [0, 35], [0, -35]]) {
      const h = archipelago.heightAt(bx + ox, bz + oz); if (h > hi) hi = h;
      if (h > 0.15 && !wooded && archipelago.woodedAt(bx + ox, bz + oz)) wooded = 1;
    }
    const shore = THREE.MathUtils.clamp((hi + 4) / 4, 0, 1);   // −4 m deep → 0, at/above water → 1
    let hd = 1e9;
    for (const [hx, hz] of HARBOR_POINTS) { const d = Math.hypot(hx - bx, hz - bz); if (d < hd) hd = d; }
    const harbor = THREE.MathUtils.clamp((360 - hd) / 300, 0, 1);
    audio.setEnv({ shore, harbor, wooded, motorOn: boat.state.motorOn, throttle: boat.state.throttle });
  }
  audio.setSpeed(boat.state.speed);
  audio.setWind(THREE.MathUtils.clamp((wind.speed - 0.55) / 0.85, 0, 1));
  audio.setHeel(boat.state.heel, dt);   // the rig creaks as she loads up
  composer.render();

  if (firstFrame) {
    firstFrame = false;
    const l = document.getElementById('loader');
    if (l) { l.classList.add('hidden'); setTimeout(() => l.remove(), 1400); }
  }
}
animate();

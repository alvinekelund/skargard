import * as THREE from 'three';
import { createWake } from './wake.js';
import { buildSwan36, sailUniforms } from './swan36.js';

/* ───────────────────────────────────────────────────────────────────────────
   A Nautor Swan 36 (S&S, 1967) + a heavy-displacement sailing model.

   Feel goals: real momentum (6.5 tonnes — ~10 s to wind up, long glide, carries
   way through a tack), real points of sail (no-go zone, fastest on a reach,
   hull-speed wall ~7.5 kn), a rudder that scrubs speed in hard turns, and heel
   that builds like a spring — gust → lean → settle. Frame-rate independent.

   Verified by simulation with this exact integrator (dt = 1/60):
     terminal 4.0 m/s (7.8 kn) on a beam reach · 50% speed at 3.6 s, 90% at 9.9 s
     tack from close-hauled: enters 2.0 m/s, carries 0.8 m/s through the eye
     full-rudder circle: 32% speed scrub at 22°/s
   ─────────────────────────────────────────────────────────────────────────── */

const DEG = Math.PI / 180;

const CFG = {
  maxThrust: 3.6,          // peak drive on a reach
  dragLinear: 0.16,
  dragQuad: 0.16,          // quad-dominant → the hull-speed wall
  mass: 5.0,               // heavy displacement feel (τ ≈ 3.5 s near terminal)
  turnRate: 0.42,          // rad/s (24°/s) max yaw — big fin-keel boat
  turnSpeedRef: 3.0,       // speed at which steering reaches full authority
  turnMin: 0.12,           // nearly dead rudder with no way on
  rudderDragQuad: 0.22,    // hard rudder adds quadratic drag (32% scrub in a circle)
  noGoHalfAngle: 42 * DEG, // half-width of the in-irons no-go zone
  heelMax: 24 * DEG,
  heelStiffness: 3.2,      // 2nd-order heel spring: Tn ≈ 3.5 s
  heelDamping: 2.0,        //   ζ ≈ 0.56 → lean, one gentle overshoot, settle
  heelSpeedRef: 4.0,
  leeway: 0.10,            // sideways slip, weighted toward upwind sailing
  draftShore: -0.9,        // 1.8 m draft → grounds on rock this far under
};

// drive efficiency vs angle off the wind: no-go cone, rising drive to a broad
// plateau around a beam/broad reach, easing to 0.65 dead downwind (a run is
// slower than a reach, but a boat still sails — she never stalls square).
function pointOfSail(angleToWind) {
  const a = Math.abs(angleToWind);              // 0..PI
  if (a < CFG.noGoHalfAngle) {
    return 0.04 * (a / CFG.noGoHalfAngle);      // in irons
  }
  const t = (a - CFG.noGoHalfAngle) / (Math.PI - CFG.noGoHalfAngle); // 0..1
  const s01 = (x) => { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  if (t < 0.35) return 0.15 + 0.85 * s01(t / 0.35);   // powering up off the wind
  if (t < 0.62) return 1.0;                           // the reach plateau
  return 1.0 - 0.35 * s01((t - 0.62) / 0.38);         // easing to 0.65 on a dead run
}

export function createBoat(scene) {
  const group = new THREE.Group();

  // ── the boat: a procedurally lofted Swan 36 floating on her lines (y=0) ──
  const swan = buildSwan36({ withSails: true });
  swan.rotation.y = -Math.PI / 2;               // Swan +X (bow) → game +Z (forward)
  group.add(swan);

  // re-rig the boom + mainsail onto a pivot at the mast so the sheet can trim them
  const MAST_X = 1.60;
  const sailPivot = new THREE.Group();
  sailPivot.position.set(MAST_X, 0, 0);
  swan.add(sailPivot);
  for (const name of ['boom', 'mainsail']) {
    const o = swan.getObjectByName(name);
    if (o) { o.parent.remove(o); o.position.x -= MAST_X; sailPivot.add(o); }
  }

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(group);
  const wake = createWake(scene);

  // ── dynamic state ──
  const state = {
    pos: new THREE.Vector3(0, 0, 0),
    heading: Math.PI,
    speed: 0,
    heel: 0, heelVel: 0,
    pitch: 0, pitchVel: 0,
    waveRoll: 0, waveRollVel: 0,
    heave: 0,
    rudder: 0, yawRate: 0,
    sheet: 0.5,
    inIrons: false,
    drive: 0,
    pointOfSailName: '—',
    // wind drama + auxiliary engine
    side: 1, prevRel: 0, lastCross: -10, boomSwing: null, shudder: null,
    flap: 0, event: null,
    motorOn: false, throttle: 0,
  };

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();

  function update(dt, ctx) {
    const { input, windDir, windSpeed, waveHeightAt } = ctx;

    fwd.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    right.set(fwd.z, 0, -fwd.x);

    // angle between where the boat points and where the wind comes FROM
    const windFrom = Math.atan2(windDir.x, windDir.z);
    let rel = state.heading - windFrom;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const eff = pointOfSail(rel);
    state.inIrons = eff < 0.08;

    // LUFFING: approaching the no-go zone the leech starts to tremble well before
    // the drive dies — head-to-wind the sails flog outright (apparent wind grows
    // with boat speed, so charging into the wind flogs harder)
    const aAbs = Math.abs(rel);
    const luffZone = CFG.noGoHalfAngle * 1.3;
    const luffDepth = THREE.MathUtils.clamp((luffZone - aAbs) / luffZone, 0, 1);
    const apparent = THREE.MathUtils.clamp(windSpeed + state.speed / 7.5, 0, 1.4);
    const flapTarget = luffDepth * luffDepth * (0.35 + 0.65 * apparent);
    state.flap += (flapTarget - state.flap) * (1 - Math.exp(-6 * dt));

    // sail trim auto-eases toward the ideal for the point of sail;
    // when the engine is on, ↑/↓ become the throttle instead
    const idealSheet = THREE.MathUtils.clamp(Math.abs(rel) / Math.PI, 0.05, 1.0);
    state.sheet += (idealSheet - state.sheet) * (1 - Math.exp(-3.0 * dt));
    if (state.motorOn) {
      if (input.sheetIn) state.throttle = Math.min(1, state.throttle + 0.55 * dt);
      if (input.sheetOut) state.throttle = Math.max(0, state.throttle - 0.55 * dt);
    } else {
      if (input.sheetIn) state.sheet = Math.max(0.05, state.sheet - 0.6 * dt);
      if (input.sheetOut) state.sheet = Math.min(1.0, state.sheet + 0.6 * dt);
    }

    // drive vs drag — quad-dominant drag is the hull-speed wall; the rudder
    // hard over brakes, and flogging sails are airbrakes. The auxiliary diesel
    // pushes ~6 kn flat out, wind or no wind.
    const motorThrust = state.motorOn ? 2.2 * state.throttle : 0;
    const drive = CFG.maxThrust * eff * (0.5 + 0.5 * windSpeed) + motorThrust;
    state.drive = drive;
    const v = state.speed;
    const quad = CFG.dragQuad + CFG.rudderDragQuad * Math.abs(state.rudder);
    const drag = (CFG.dragLinear + 0.45 * state.flap) * v + quad * v * Math.abs(v);
    state.speed += (drive - drag) / CFG.mass * dt;
    if (state.speed < 0) state.speed = 0;

    // steering — the tiller takes a moment to put over; authority needs way on
    const steerInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    state.rudder += (steerInput - state.rudder) * (1 - Math.exp(-5 * dt));
    const authority = CFG.turnMin + (1 - CFG.turnMin) * THREE.MathUtils.clamp(state.speed / CFG.turnSpeedRef, 0, 1);
    const yawTarget = state.rudder * CFG.turnRate * authority;
    state.yawRate += (yawTarget - state.yawRate) * (1 - Math.exp(-6 * dt));
    state.heading += state.yawRate * dt;
    state.turn = THREE.MathUtils.clamp(Math.abs(state.yawRate) * state.speed / 3.5, 0, 1); // skid 0..1

    // leeway is an upwind phenomenon — weight it toward close-hauled sailing
    const upwind = THREE.MathUtils.clamp(1 - Math.abs(rel) / (Math.PI * 0.55), 0, 1);
    const leeMag = Math.sign(rel || 1) * state.speed * CFG.leeway * (0.35 + 0.65 * upwind);
    let stepX = (fwd.x * state.speed + right.x * leeMag) * dt;
    let stepZ = (fwd.z * state.speed + right.z * leeMag) * dt;

    // collision: she draws 1.8 m — grounds on submerged rock, slides along shore
    const land = ctx.landHeightAt || (() => -10);
    const SHORE = CFG.draftShore;
    let nx = state.pos.x + stepX, nz = state.pos.z + stepZ;
    if (land(nx, nz) > SHORE) {
      const e = 1.2;
      const gx = land(state.pos.x + e, state.pos.z) - land(state.pos.x - e, state.pos.z);
      const gz = land(state.pos.x, state.pos.z + e) - land(state.pos.x, state.pos.z - e);
      const gl = Math.hypot(gx, gz) || 1;
      const nX = gx / gl, nZ = gz / gl;
      const into = stepX * nX + stepZ * nZ;
      const tx = stepX - into * nX, tz = stepZ - into * nZ;
      nx = state.pos.x + tx; nz = state.pos.z + tz;
      if (land(nx, nz) > SHORE) { nx = state.pos.x; nz = state.pos.z; }
      state.speed *= 0.55;
      state.grounded = true;
    } else state.grounded = false;
    state.pos.x = nx; state.pos.z = nz;

    // heel: 2nd-order spring — a gust leans her over a beat later, then settles.
    // wind² in the target makes gusts read; turn lean couples yaw into roll.
    const heelDir = -Math.sign(rel || 1);
    const heelTarget = heelDir * CFG.heelMax * eff * (windSpeed * windSpeed) *
      THREE.MathUtils.clamp(0.3 + state.speed / CFG.heelSpeedRef, 0, 1);
    state.heelVel += (CFG.heelStiffness * (heelTarget - state.heel) - CFG.heelDamping * state.heelVel) * dt;
    state.heel += state.heelVel * dt;

    // buoyancy: long-baseline sampling low-passes the chop (a 36-footer doesn't
    // bounce on 6 m wavelets); 2nd-order springs give one gentle overshoot
    const t = ctx.time;
    const wAt = waveHeightAt || (() => 0);
    const px = state.pos.x, pz = state.pos.z;
    const L = 4.1, B = 1.75;
    const yHere = wAt(px, pz, t);
    const yF = wAt(px + fwd.x * L, pz + fwd.z * L, t);
    const yB = wAt(px - fwd.x * L, pz - fwd.z * L, t);
    const yP = wAt(px + right.x * B, pz + right.z * B, t);
    const yS = wAt(px - right.x * B, pz - right.z * B, t);
    const wavePitch = Math.atan2(yB - yF, 2 * L);
    const waveRoll = Math.atan2(yS - yP, 2 * B);
    { // pitch: ωn=1.9, ζ=0.60 · roll: ωn=2.6, ζ=0.45 (slightly underdamped = alive)
      const wp = 1.9, zp = 0.60, wr = 2.6, zr = 0.45;
      state.pitchVel += (wp * wp * (wavePitch - state.pitch) - 2 * zp * wp * state.pitchVel) * dt;
      state.pitch += state.pitchVel * dt;
      state.waveRollVel += (wr * wr * (waveRoll - state.waveRoll) - 2 * zr * wr * state.waveRollVel) * dt;
      state.waveRoll += state.waveRollVel * dt;
    }
    state.heave += (yHere - state.heave) * (1 - Math.exp(-4.5 * dt));

    // compose: heel + wave roll + turn lean · wave pitch + speed trim (bow-up)
    const turnLean = THREE.MathUtils.clamp(0.012 * state.yawRate * state.speed, -0.105, 0.105);
    const speedTrim = -0.0016 * state.speed * state.speed;
    group.position.set(px, state.heave + 0.02, pz);
    group.rotation.set(0, state.heading, 0, 'YXZ');
    group.rotateX(state.pitch + speedTrim);
    group.rotateZ(state.heel + state.waveRoll * 0.85 + turnLean);

    // BOOM CROSSINGS: crossing the wind swings the rig to the new side.
    // Bow through the wind = a tack: controlled, ~0.7 s. Stern through the
    // wind = a GYBE: the boom whips across in a quarter second, the rig rings
    // out, she lurches into a heel spike and sheds speed. Don't do it by accident.
    const side = rel >= 0 ? 1 : -1;
    const sailAngle = (0.12 + state.sheet * 1.05) * -side;

    if (side !== state.side && (t - state.lastCross) > 1.0) {
      const type = Math.abs(state.prevRel) > Math.PI / 2 ? 'gybe' : 'tack';
      state.lastCross = t;
      state.boomSwing = { from: sailPivot.rotation.y, to: sailAngle, t: 0, dur: type === 'gybe' ? 0.25 : 0.7, type };
      if (type === 'gybe') {
        const load = 0.4 + 0.6 * state.sheet;                      // eased-out main slams hardest
        state.heelVel += -side * (0.40 + 0.35 * windSpeed) * load; // 8–15° spike, peaking ~0.7 s later
        state.speed *= 1 - 0.10 * load;
        state.event = { type: 'gybe', mag: load };
      } else {
        state.heelVel += -side * 0.06;                             // a modest thunk
        state.event = { type: 'tack', mag: 0.3 };
      }
    }
    state.side = side; state.prevRel = rel;

    if (state.boomSwing) {
      const b = state.boomSwing; b.t += dt;
      const tt = Math.min(b.t / b.dur, 1);
      const p = b.type === 'gybe' ? tt * tt * tt                   // accelerating whip
                                  : tt * tt * (3 - 2 * tt);        // controlled sweep
      sailPivot.rotation.y = b.from + (b.to - b.from) * p;
      if (tt >= 1) {
        if (b.type === 'gybe') state.shudder = { t: 0, amp: (b.to - b.from) * 0.05 };
        state.boomSwing = null;
      }
    } else {
      sailPivot.rotation.y += (sailAngle - sailPivot.rotation.y) * (1 - Math.exp(-5 * dt));
    }
    if (state.shudder) {                                           // rig rings out after the slam
      const s2 = state.shudder; s2.t += dt;
      sailPivot.rotation.y += s2.amp * Math.exp(-s2.t * 8) * Math.sin(s2.t * 38);
      if (s2.t > 0.8) state.shudder = null;
    }
    sailPivot.rotation.y += state.flap * 0.03 * Math.sin(t * 26);  // whole-rig tremble

    // drive the sail flutter shader
    sailUniforms.uTime.value = t;
    sailUniforms.uFlap.value = Math.max(state.flap, 0.08 * (ctx.gust || 0));

    wake.update(state, fwd, t, wAt);

    const a = Math.abs(rel) / DEG;
    state.pointOfSailName =
      state.motorOn && state.throttle > 0.02 ? 'Under power' :
      state.inIrons ? 'In irons' :
      state.flap > 0.12 ? 'Luffing' :
      a < 60 ? 'Close hauled' : a < 100 ? 'Beam reach' : a < 150 ? 'Broad reach' : 'Running';

    return state;
  }

  return { group, state, update, get heading() { return state.heading; } };
}

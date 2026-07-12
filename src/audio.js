/* Ambience: a warm day under sail, built from designed layers instead of a
   filtered recording (the old mp3 through a 680 Hz low-pass read as a
   "high-tech buzz" — all drone, no life). The picture painted in sound:

     · water lapping the hull — irregular, gentle, stereo, the defining sound;
       quickens and firms up a little as the boat gathers way
     · a soft bed of moving water, breathing on a slow swell
     · warm air — the faintest high, open hiss, so the scene isn't sealed shut
     · bow-wash that rises with speed
     · now and then, far off, a gull

   Starts MUTED, always (the 🔇 button opts in; autoplay is never allowed).
   The voice builders are exported so an OfflineAudioContext can render and
   analyse the same recipe headlessly. */

export function makeNoiseBuffer(ctx, seconds = 2, pink = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (!pink) {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else {
    // Paul Kellet's economy pink filter — flat-ish tilt without brown mud
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28;
    }
  }
  return buf;
}

// one lap of water against planking: a short shaped noise burst through a
// band-pass, panned to a side of the hull
export function splashVoice(ctx, dest, noiseBuf, t, o = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = o.rate ?? 1;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = o.freq ?? 1200;
  bp.Q.value = o.q ?? 1.4;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.peak ?? 0.16, t + (o.attack ?? 0.012));
  g.gain.exponentialRampToValueAtTime(0.0001, t + (o.attack ?? 0.012) + (o.decay ?? 0.32));
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  src.connect(bp);
  bp.connect(g);
  if (pan) { pan.pan.value = o.pan ?? 0; g.connect(pan); pan.connect(dest); }
  else g.connect(dest);
  src.start(t);
  src.stop(t + (o.attack ?? 0.012) + (o.decay ?? 0.32) + 0.05);
  return src;
}

// a distant gull: pitch-bent saw through a low-pass, vibrato on the tail
export function gullCry(ctx, dest, t, o = {}) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const f0 = o.f0 ?? 1250, f1 = o.f1 ?? 820, dur = o.dur ?? 0.38;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const vib = ctx.createOscillator();
  vib.frequency.value = 26;
  const vibG = ctx.createGain();
  vibG.gain.value = 22;
  vib.connect(vibG); vibG.connect(osc.frequency);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2100; lp.Q.value = 0.4;
  const g = ctx.createGain();
  const lvl = o.level ?? 0.035;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(lvl, t + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  osc.connect(lp); lp.connect(g);
  if (pan) { pan.pan.value = o.pan ?? 0; g.connect(pan); pan.connect(dest); }
  else g.connect(dest);
  osc.start(t); osc.stop(t + dur + 0.02);
  vib.start(t); vib.stop(t + dur + 0.02);
}

// the continuous layers (bed, air, bow-wash) — shared by live and offline use
export function buildBeds(ctx, dest) {
  const pinkBuf = makeNoiseBuffer(ctx, 2.5, true);
  const whiteBuf = makeNoiseBuffer(ctx, 2, false);

  // moving-water bed: pink noise banded mid, breathing on a slow swell
  const bed = ctx.createBufferSource();
  bed.buffer = pinkBuf; bed.loop = true;
  const bedBp = ctx.createBiquadFilter();
  bedBp.type = 'bandpass'; bedBp.frequency.value = 640; bedBp.Q.value = 0.45;
  const bedG = ctx.createGain(); bedG.gain.value = 0.085;
  bed.connect(bedBp); bedBp.connect(bedG); bedG.connect(dest);
  const bedLfo = ctx.createOscillator(); bedLfo.frequency.value = 0.06;
  const bedLfoG = ctx.createGain(); bedLfoG.gain.value = 0.018;
  bedLfo.connect(bedLfoG); bedLfoG.connect(bedG.gain);
  bed.start(); bedLfo.start();

  // warm air: a whisper of open high, so the day sounds wide, not sealed
  const air = ctx.createBufferSource();
  air.buffer = whiteBuf; air.loop = true;
  const airHp = ctx.createBiquadFilter();
  airHp.type = 'highpass'; airHp.frequency.value = 1500; airHp.Q.value = 0.3;
  const airG = ctx.createGain(); airG.gain.value = 0.022;
  air.connect(airHp); airHp.connect(airG); airG.connect(dest);
  const airLfo = ctx.createOscillator(); airLfo.frequency.value = 0.13;
  const airLfoG = ctx.createGain(); airLfoG.gain.value = 0.006;
  airLfo.connect(airLfoG); airLfoG.connect(airG.gain);
  air.start(); airLfo.start();

  // bow-wash: silent at rest, a steady rush as the boat gathers way
  const wash = ctx.createBufferSource();
  wash.buffer = whiteBuf; wash.loop = true;
  const washBp = ctx.createBiquadFilter();
  washBp.type = 'bandpass'; washBp.frequency.value = 950; washBp.Q.value = 0.8;
  const washG = ctx.createGain(); washG.gain.value = 0;
  wash.connect(washBp); washBp.connect(washG); washG.connect(dest);
  wash.start();

  // wind in the rig: a broad breathy layer that firms up with the breeze, with
  // a faint higher whistle over it — the sound of air over shrouds and sails.
  // Silent-ish at calm, never a gale. Driven by setWind().
  const wind = ctx.createBufferSource();
  wind.buffer = pinkBuf; wind.loop = true;
  const windBp = ctx.createBiquadFilter();
  windBp.type = 'bandpass'; windBp.frequency.value = 420; windBp.Q.value = 0.5;
  const windG = ctx.createGain(); windG.gain.value = 0.0;
  wind.connect(windBp); windBp.connect(windG); windG.connect(dest);
  const whistle = ctx.createBufferSource();
  whistle.buffer = whiteBuf; whistle.loop = true;
  const whHp = ctx.createBiquadFilter();
  whHp.type = 'bandpass'; whHp.frequency.value = 2400; whHp.Q.value = 1.1;
  const whG = ctx.createGain(); whG.gain.value = 0.0;
  whistle.connect(whHp); whHp.connect(whG); whG.connect(dest);
  // gusty flutter on the wind gain so it isn't a flat hiss
  const windLfo = ctx.createOscillator(); windLfo.frequency.value = 0.21;
  const windLfoG = ctx.createGain(); windLfoG.gain.value = 0.01;
  windLfo.connect(windLfoG); windLfoG.connect(windG.gain);
  wind.start(); whistle.start(); windLfo.start();

  // shore wash: a soft, slow surge of water on rock that rises as you close a
  // shoreline — the sound that tells you land is near even with eyes shut
  const shore = ctx.createBufferSource();
  shore.buffer = pinkBuf; shore.loop = true;
  const shoreBp = ctx.createBiquadFilter();
  shoreBp.type = 'bandpass'; shoreBp.frequency.value = 300; shoreBp.Q.value = 0.6;
  const shoreG = ctx.createGain(); shoreG.gain.value = 0.0;
  shore.connect(shoreBp); shoreBp.connect(shoreG); shoreG.connect(dest);
  const shoreLfo = ctx.createOscillator(); shoreLfo.frequency.value = 0.12;
  const shoreLfoG = ctx.createGain(); shoreLfoG.gain.value = 0.5;   // deep swell in the surge
  shoreLfo.connect(shoreLfoG); shoreLfoG.connect(shoreG.gain);
  shore.start(); shoreLfo.start();

  // trees in the wind: the soft surging "shhhh" of a breeze through pines that
  // you hear when you close a wooded shore — the land's own voice, riding above
  // the low water-on-rock wash. Rises with shore proximity AND the breeze,
  // gusting on its own slow LFO. Driven by setEnv(wooded) × setWind().
  const leaves = ctx.createBufferSource();
  leaves.buffer = whiteBuf; leaves.loop = true;
  const leavesBp = ctx.createBiquadFilter();
  leavesBp.type = 'bandpass'; leavesBp.frequency.value = 1900; leavesBp.Q.value = 0.5;
  const leavesG = ctx.createGain(); leavesG.gain.value = 0.0;
  leaves.connect(leavesBp); leavesBp.connect(leavesG); leavesG.connect(dest);
  const leavesLfo = ctx.createOscillator(); leavesLfo.frequency.value = 0.17;
  const leavesLfoG = ctx.createGain(); leavesLfoG.gain.value = 0.35;   // gusts surge through the canopy
  leavesLfo.connect(leavesLfoG); leavesLfoG.connect(leavesG.gain);
  leaves.start(); leavesLfo.start();

  return { whiteBuf, washGain: washG, windGain: windG, whistleGain: whG, shoreGain: shoreG, leavesGain: leavesG };
}

// a halyard tapping an aluminium mast — the sound of a full guest harbour. A
// short metallic ping: a couple of detuned high partials with a fast decay.
export function halyardClink(ctx, dest, t, o = {}) {
  const base = o.freq ?? 2100;
  for (const [mult, lvl] of [[1, 1], [2.76, 0.5], [5.4, 0.25]]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = base * mult * (0.98 + Math.random() * 0.04);
    const g = ctx.createGain();
    const peak = (o.level ?? 0.05) * lvl;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12 + Math.random() * 0.1);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    osc.connect(g);
    if (pan) { pan.pan.value = o.pan ?? 0; g.connect(pan); pan.connect(dest); }
    else g.connect(dest);
    osc.start(t); osc.stop(t + 0.4);
  }
}

export function createAudio() {
  let ctx = null, started = false, muted = true;
  let master = null, washGain = null, whiteBuf = null;
  let windGain = null, whistleGain = null, shoreGain = null, leavesGain = null;
  let engine = null;                       // { gain, osc, sub } diesel throb
  let speedNorm = 0;                       // 0..1, from setSpeed
  let windNorm = 0, shoreNorm = 0, harborNorm = 0, woodedNorm = 0, motorOn = false, throttle = 0;
  let lapTimer = null, gullTimer = null, clinkTimer = null;
  let heelPrev = 0, lastCreak = 0;

  // the rig and deck CREAK as she loads up — a low woody groan whenever the
  // heel changes fast (a gust leaning her over, a tack coming through). Two
  // detuned low band-passed noise bursts with a slow downward bend: timber
  // and rope working, the sound that makes a boat feel like a living thing.
  function creak(intensity) {
    const t = ctx.currentTime + 0.01;
    for (const [freq, lvl, dur] of [[210 + Math.random() * 90, 1.0, 0.5], [96, 0.55, 0.62]]) {
      const src = ctx.createBufferSource();
      src.buffer = whiteBuf; src.loop = true;
      src.playbackRate.setValueAtTime(1.0, t);
      src.playbackRate.linearRampToValueAtTime(0.72, t + dur);        // the groan bends down
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 9;
      bp.frequency.linearRampToValueAtTime(freq * 0.8, t + dur);
      const g = ctx.createGain();
      const peak = 0.10 * intensity * lvl;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), t + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(t); src.stop(t + dur + 0.05);
    }
  }

  // heel (radians) sampled every frame; a fast change past the threshold works
  // the rig. Rate-limited so a rolly sea doesn't turn into a haunted house.
  function setHeel(heel, dt) {
    if (!ctx || muted || !whiteBuf || !dt) { heelPrev = heel; return; }
    const rate = Math.abs(heel - heelPrev) / dt;         // rad/s
    heelPrev = heel;
    const now = ctx.currentTime;
    if (rate > 0.055 && now - lastCreak > 2.2 + Math.random() * 2.5) {
      lastCreak = now;
      creak(Math.min(1, rate / 0.16));
    }
  }

  // a small diesel auxiliary: a low throbbing tone (firing frequency) with a
  // sub and a little grille rattle, amplitude-pulsed so it chugs
  function buildEngine() {
    const g = ctx.createGain(); g.gain.value = 0; g.connect(master);
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 46;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 0.7;
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 23;
    const subG = ctx.createGain(); subG.gain.value = 0.5;
    // chug: amplitude pulse a touch above idle firing rate
    const pulse = ctx.createOscillator(); pulse.type = 'sine'; pulse.frequency.value = 7.5;
    const pulseG = ctx.createGain(); pulseG.gain.value = 0.35;
    const inner = ctx.createGain(); inner.gain.value = 0.7;
    osc.connect(lp); lp.connect(inner); sub.connect(subG); subG.connect(inner);
    inner.connect(g);
    pulse.connect(pulseG); pulseG.connect(inner.gain);
    osc.start(); sub.start(); pulse.start();
    return { gain: g, osc, sub };
  }

  function scheduleClink() {
    // halyards tapping masts: only when a guest harbour is close, and denser
    // the closer you are (a full harbour is a whole chorus of them)
    const wait = (0.5 + Math.random() * 2.2) / (0.15 + harborNorm);
    clinkTimer = setTimeout(() => {
      if (ctx && !muted && harborNorm > 0.05 && Math.random() < 0.4 + harborNorm * 0.5) {
        const n = 1 + Math.floor(Math.random() * 2);
        const pan = (Math.random() * 2 - 1) * 0.8;
        const freq = 1700 + Math.random() * 900;
        for (let k = 0; k < n; k++) {
          halyardClink(ctx, master, ctx.currentTime + 0.02 + k * (0.13 + Math.random() * 0.12),
            { freq, level: (0.02 + Math.random() * 0.05) * harborNorm, pan });
        }
      }
      scheduleClink();
    }, wait * 1000);
  }

  function scheduleLap() {
    // quicker, slightly firmer laps under way; lazy and soft at rest
    const wait = (0.55 + Math.random() * 1.3) * (1 - speedNorm * 0.45);
    lapTimer = setTimeout(() => {
      if (ctx && !muted) {
        const t = ctx.currentTime + 0.01;
        const side = Math.random() < 0.5 ? -1 : 1;
        const one = (tt, soft) => splashVoice(ctx, master, whiteBuf, tt, {
          freq: 750 + Math.random() * 1500,
          q: 1.0 + Math.random() * 1.2,
          // the narrow band-pass eats most of the burst's broadband energy —
          // the gain here compensates for that filter loss
          peak: (0.7 + Math.random() * 0.9) * (0.55 + speedNorm * 0.45) * (soft ? 0.6 : 1),
          attack: 0.006 + Math.random() * 0.016,
          decay: 0.18 + Math.random() * 0.3,
          pan: side * (0.25 + Math.random() * 0.4),
          rate: 0.8 + Math.random() * 0.5,
        });
        one(t, false);
        if (Math.random() < 0.35) one(t + 0.09 + Math.random() * 0.07, true);  // slap-slap
      }
      scheduleLap();
    }, wait * 1000);
  }

  function scheduleGull() {
    gullTimer = setTimeout(() => {
      if (ctx && !muted && Math.random() < 0.6) {
        const cries = 1 + Math.floor(Math.random() * 3);
        const pan = (Math.random() * 2 - 1) * 0.7;
        const f0 = 1150 + Math.random() * 250;
        for (let k = 0; k < cries; k++) {
          gullCry(ctx, master, ctx.currentTime + 0.02 + k * (0.26 + Math.random() * 0.14), {
            f0, f1: f0 * (0.62 + Math.random() * 0.1),
            dur: 0.3 + Math.random() * 0.14,
            level: 0.04 + Math.random() * 0.03,
            pan,
          });
        }
      }
      scheduleGull();
    }, (16 + Math.random() * 26) * 1000);
  }

  function start() {
    if (started) return; started = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const beds = buildBeds(ctx, master);
    washGain = beds.washGain;
    whiteBuf = beds.whiteBuf;
    windGain = beds.windGain; whistleGain = beds.whistleGain; shoreGain = beds.shoreGain;
    leavesGain = beds.leavesGain;
    engine = buildEngine();

    scheduleLap();
    scheduleGull();
    scheduleClink();

    if (!muted) master.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 2.5);
  }

  // boat speed (m/s) → livelier laps + the bow-wash rush
  function setSpeed(spd) {
    speedNorm = Math.min(Math.max(spd, 0) / 6.5, 1);
    if (ctx && washGain) washGain.gain.setTargetAtTime(speedNorm * 0.12, ctx.currentTime, 0.9);
  }

  // apparent wind (0..1) → the rig sings; a whisper of whistle only up high
  function setWind(norm) {
    windNorm = Math.min(Math.max(norm, 0), 1);
    if (ctx && windGain) {
      windGain.gain.setTargetAtTime(0.02 + windNorm * 0.09, ctx.currentTime, 1.2);
      whistleGain.gain.setTargetAtTime(windNorm * windNorm * 0.02, ctx.currentTime, 1.2);
    }
    updateLeaves();
  }

  // trees in the wind: only audible when close to a WOODED shore, and louder in
  // a breeze — so a bare rock skerry stays quiet and a pine-clad island whispers
  function updateLeaves() {
    if (!ctx || !leavesGain) return;
    const lvl = shoreNorm * woodedNorm * (0.25 + 0.75 * windNorm) * 0.06;
    leavesGain.gain.setTargetAtTime(lvl, ctx.currentTime, 0.8);
  }

  // scene context: shore proximity (0..1), nearest guest harbour (0..1),
  // engine on + throttle — drives the shore wash, halyard chorus, diesel throb
  function setEnv(o = {}) {
    shoreNorm = Math.min(Math.max(o.shore ?? 0, 0), 1);
    harborNorm = Math.min(Math.max(o.harbor ?? 0, 0), 1);
    woodedNorm = Math.min(Math.max(o.wooded ?? 0, 0), 1);
    motorOn = !!o.motorOn; throttle = Math.min(Math.max(o.throttle ?? 0, 0), 1);
    if (!ctx) return;
    if (shoreGain) shoreGain.gain.setTargetAtTime(shoreNorm * shoreNorm * 0.11, ctx.currentTime, 1.0);
    updateLeaves();
    if (engine) {
      const lvl = motorOn ? 0.05 + throttle * 0.10 : 0;
      engine.gain.gain.setTargetAtTime(lvl, ctx.currentTime, 0.4);
      const rpm = 42 + throttle * 26;               // idle → cruising firing rate
      engine.osc.frequency.setTargetAtTime(rpm, ctx.currentTime, 0.5);
      engine.sub.frequency.setTargetAtTime(rpm * 0.5, ctx.currentTime, 0.5);
    }
  }

  function setMuted(m) {
    muted = m;
    if (!ctx) { if (!m) start(); return; }           // first unmute also starts it
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.2);
  }

  return { start, setSpeed, setWind, setEnv, setHeel, setMuted, get muted() { return muted; } };
}

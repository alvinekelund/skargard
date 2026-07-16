/* Ambience: a warm day under sail, built from designed layers instead of a
   filtered recording (the old mp3 through a 680 Hz low-pass read as a
   "high-tech buzz" — all drone, no life). The picture painted in sound:

     · water lapping the hull — irregular, gentle, stereo, the defining sound;
       quickens and firms up a little as the boat gathers way
     · a soft bed of moving water, breathing on a slow swell
     · warm air — the faintest high, open hiss, so the scene isn't sealed shut
     · bow-wash that rises with speed
     · now and then, far off, a gull
     · very sparse D-major pentatonic tones, like light glinting on the water

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

// a distant gull: a soft sine voice, far enough away to colour the place
// without becoming the familiar sharp synthetic squawk
export function gullCry(ctx, dest, t, o = {}) {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const f0 = o.f0 ?? 1250, f1 = o.f1 ?? 820, dur = o.dur ?? 0.38;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const vib = ctx.createOscillator();
  vib.frequency.value = 8;
  const vibG = ctx.createGain();
  vibG.gain.value = 9;
  vib.connect(vibG); vibG.connect(osc.frequency);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2100; lp.Q.value = 0.4;
  const g = ctx.createGain();
  const lvl = o.level ?? 0.012;
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
  bedBp.type = 'lowpass'; bedBp.frequency.value = 480; bedBp.Q.value = 0.25;
  const bedG = ctx.createGain(); bedG.gain.value = 0;
  bed.connect(bedBp); bedBp.connect(bedG); bedG.connect(dest);
  const bedLfo = ctx.createOscillator(); bedLfo.frequency.value = 0.06;
  const bedLfoG = ctx.createGain(); bedLfoG.gain.value = 0;
  bedLfo.connect(bedLfoG); bedLfoG.connect(bedG.gain);
  bed.start(); bedLfo.start();

  // warm air: a whisper of open high, so the day sounds wide, not sealed
  const air = ctx.createBufferSource();
  air.buffer = whiteBuf; air.loop = true;
  const airHp = ctx.createBiquadFilter();
  airHp.type = 'bandpass'; airHp.frequency.value = 1900; airHp.Q.value = 0.22;
  const airG = ctx.createGain(); airG.gain.value = 0;
  air.connect(airHp); airHp.connect(airG); airG.connect(dest);
  const airLfo = ctx.createOscillator(); airLfo.frequency.value = 0.13;
  const airLfoG = ctx.createGain(); airLfoG.gain.value = 0;
  airLfo.connect(airLfoG); airLfoG.connect(airG.gain);
  air.start(); airLfo.start();

  // bow-wash: silent at rest, a steady rush as the boat gathers way
  const wash = ctx.createBufferSource();
  wash.buffer = whiteBuf; wash.loop = true;
  const washBp = ctx.createBiquadFilter();
  washBp.type = 'bandpass'; washBp.frequency.value = 620; washBp.Q.value = 0.42;
  const washG = ctx.createGain(); washG.gain.value = 0;
  wash.connect(washBp); washBp.connect(washG); washG.connect(dest);
  wash.start();

  // wind in the rig: a broad breathy layer that firms up with the breeze, with
  // a faint higher whistle over it — the sound of air over shrouds and sails.
  // Silent-ish at calm, never a gale. Driven by setWind().
  const wind = ctx.createBufferSource();
  wind.buffer = pinkBuf; wind.loop = true;
  const windBp = ctx.createBiquadFilter();
  windBp.type = 'lowpass'; windBp.frequency.value = 360; windBp.Q.value = 0.22;
  const windG = ctx.createGain(); windG.gain.value = 0.0;
  wind.connect(windBp); windBp.connect(windG); windG.connect(dest);
  const whistle = ctx.createBufferSource();
  whistle.buffer = whiteBuf; whistle.loop = true;
  const whHp = ctx.createBiquadFilter();
  whHp.type = 'bandpass'; whHp.frequency.value = 1800; whHp.Q.value = 0.35;
  const whG = ctx.createGain(); whG.gain.value = 0.0;
  whistle.connect(whHp); whHp.connect(whG); whG.connect(dest);
  // gusty flutter on the wind gain so it isn't a flat hiss
  const windLfo = ctx.createOscillator(); windLfo.frequency.value = 0.21;
  // Never modulate a gain parameter by a fixed amount: doing so made this
  // layer audible (and negative half the time) even when setWind requested
  // silence. Environmental gain is smoothed directly by setWind instead.
  const windLfoG = ctx.createGain(); windLfoG.gain.value = 0;
  windLfo.connect(windLfoG); windLfoG.connect(windG.gain);
  wind.start(); whistle.start(); windLfo.start();

  // shore wash: a soft, slow surge of water on rock that rises as you close a
  // shoreline — the sound that tells you land is near even with eyes shut
  const shore = ctx.createBufferSource();
  shore.buffer = pinkBuf; shore.loop = true;
  const shoreBp = ctx.createBiquadFilter();
  shoreBp.type = 'lowpass'; shoreBp.frequency.value = 260; shoreBp.Q.value = 0.25;
  const shoreG = ctx.createGain(); shoreG.gain.value = 0.0;
  shore.connect(shoreBp); shoreBp.connect(shoreG); shoreG.connect(dest);
  const shoreLfo = ctx.createOscillator(); shoreLfo.frequency.value = 0.12;
  // This used to be 0.22, added directly to shoreG.gain. It overwhelmed the
  // whole mix with a pulsing industrial rumble, including far out at sea.
  const shoreLfoG = ctx.createGain(); shoreLfoG.gain.value = 0;
  shoreLfo.connect(shoreLfoG); shoreLfoG.connect(shoreG.gain);
  shore.start(); shoreLfo.start();

  // trees in the wind — the land's own voice when you close a wooded shore,
  // built from TWO voices like the real mixed forest: the deep, hollow
  // soughing of pine crowns (honka humisee — the sound of the whole wood
  // breathing) under the lighter pattering rustle of birch leaves. Each voice
  // gusts on its own slow LFO so they weave instead of swelling in lockstep.
  const leavesG = ctx.createGain(); leavesG.gain.value = 0.0;
  leavesG.connect(dest);
  for (const [freq, q, lvl, lfoHz, lfoAmt] of [[480, 0.35, 0.65, 0.09, 0.25], [1800, 0.4, 0.22, 0.14, 0.3]]) {
    const src = ctx.createBufferSource();
    src.buffer = pinkBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const vg = ctx.createGain(); vg.gain.value = lvl;
    src.connect(bp); bp.connect(vg); vg.connect(leavesG);
    const lfo = ctx.createOscillator(); lfo.frequency.value = lfoHz;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0;
    lfo.connect(lfoG); lfoG.connect(vg.gain);
    src.start(); lfo.start();
  }

  return { whiteBuf, washGain: washG, windGain: windG, whistleGain: whG, shoreGain: shoreG, leavesGain: leavesG };
}

export function createAudio() {
  let ctx = null, started = false, muted = true;
  let master = null, washGain = null, whiteBuf = null;
  let windGain = null, whistleGain = null, shoreGain = null, leavesGain = null;
  let engine = null;                       // { gain, osc, sub } diesel throb
  let speedNorm = 0;                       // 0..1, from setSpeed
  let windNorm = 0, shoreNorm = 0, woodedNorm = 0, motorOn = false, throttle = 0;
  let lapTimer = null, gullTimer = null, toneTimer = null;
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
      const peak = 0.022 * intensity * lvl;
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
    if (rate > 0.09 && now - lastCreak > 7 + Math.random() * 5) {
      lastCreak = now;
      creak(Math.min(1, rate / 0.16));
    }
  }

  // a small diesel auxiliary: a low throbbing tone (firing frequency) with a
  // sub and a little grille rattle, amplitude-pulsed so it chugs
  function buildEngine() {
    const g = ctx.createGain(); g.gain.value = 0; g.connect(master);
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 46;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150; lp.Q.value = 0.35;
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

  // A rare musical glint, almost below conscious attention. Keeping this to a
  // single low sine avoids the synthetic chime/notification quality that the
  // former bright two-part tones acquired over headphones.
  function softTone(t) {
    const notes = [146.83, 164.81, 185.0, 220.0];
    const f = notes[Math.floor(Math.random() * notes.length)];
    for (const [mult, level] of [[1, 0.0018]]) {
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 3.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 12.0);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      osc.connect(g);
      if (pan) { pan.pan.value = (Math.random() - 0.5) * 0.7; g.connect(pan); pan.connect(master); }
      else g.connect(master);
      osc.start(t); osc.stop(t + 12.2);
    }
  }

  function scheduleTone() {
    toneTimer = setTimeout(() => {
      if (ctx && !muted) softTone(ctx.currentTime + 0.05);
      scheduleTone();
    }, (75 + Math.random() * 90) * 1000);
  }

  function scheduleLap() {
    // quicker, slightly firmer laps under way; lazy and soft at rest
    const wait = (2.6 + Math.random() * 3.8) * (1 - speedNorm * 0.15);
    lapTimer = setTimeout(() => {
      if (ctx && !muted) {
        const t = ctx.currentTime + 0.01;
        const side = Math.random() < 0.5 ? -1 : 1;
        const one = (tt, soft) => splashVoice(ctx, master, whiteBuf, tt, {
          freq: 430 + Math.random() * 650,
          q: 0.45 + Math.random() * 0.35,
          peak: (0.012 + Math.random() * 0.016) * (0.65 + speedNorm * 0.18) * (soft ? 0.4 : 1),
          attack: 0.035 + Math.random() * 0.04,
          decay: 0.55 + Math.random() * 0.55,
          pan: side * (0.25 + Math.random() * 0.4),
          rate: 0.8 + Math.random() * 0.5,
        });
        one(t, false);
        if (Math.random() < 0.16) one(t + 0.22 + Math.random() * 0.14, true);
      }
      scheduleLap();
    }, wait * 1000);
  }

  function scheduleGull() {
    gullTimer = setTimeout(() => {
      if (ctx && !muted && Math.random() < 0.38) {
        const cries = 1;
        const pan = (Math.random() * 2 - 1) * 0.7;
        const f0 = 1150 + Math.random() * 250;
        for (let k = 0; k < cries; k++) {
          gullCry(ctx, master, ctx.currentTime + 0.02 + k * (0.26 + Math.random() * 0.14), {
            f0, f1: f0 * (0.62 + Math.random() * 0.1),
            dur: 0.3 + Math.random() * 0.14,
            level: 0.008 + Math.random() * 0.006,
            pan,
          });
        }
      }
      scheduleGull();
    }, (35 + Math.random() * 40) * 1000);
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
    scheduleTone();

    if (!muted) master.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 6.0);
  }

  // boat speed (m/s) → livelier laps + the bow-wash rush
  function setSpeed(spd) {
    speedNorm = Math.min(Math.max(spd, 0) / 6.5, 1);
    if (ctx && washGain) washGain.gain.setTargetAtTime(speedNorm * 0.012, ctx.currentTime, 2.5);
  }

  // apparent wind (0..1) → the rig sings; a whisper of whistle only up high
  function setWind(norm) {
    windNorm = Math.min(Math.max(norm, 0), 1);
    if (ctx && windGain) {
      windGain.gain.setTargetAtTime(windNorm * 0.007, ctx.currentTime, 3.5);
      whistleGain.gain.setTargetAtTime(0, ctx.currentTime, 2.5);
    }
    updateLeaves();
  }

  // trees in the wind: only audible when close to a WOODED shore, and louder in
  // a breeze — so a bare rock skerry stays quiet and a pine-clad island whispers
  function updateLeaves() {
    if (!ctx || !leavesGain) return;
    const lvl = shoreNorm * woodedNorm * windNorm * 0.006;
    leavesGain.gain.setTargetAtTime(lvl, ctx.currentTime, 0.8);
  }

  // scene context: shore proximity (0..1), woodedness and engine state — drives
  // the shore wash, leaves and the deliberately subdued diesel auxiliary
  function setEnv(o = {}) {
    shoreNorm = Math.min(Math.max(o.shore ?? 0, 0), 1);
    woodedNorm = Math.min(Math.max(o.wooded ?? 0, 0), 1);
    motorOn = !!o.motorOn; throttle = Math.min(Math.max(o.throttle ?? 0, 0), 1);
    if (!ctx) return;
    if (shoreGain) shoreGain.gain.setTargetAtTime(shoreNorm * shoreNorm * 0.009, ctx.currentTime, 3.0);
    updateLeaves();
    if (engine) {
      const lvl = motorOn ? 0.012 + throttle * 0.026 : 0;
      engine.gain.gain.setTargetAtTime(lvl, ctx.currentTime, 0.4);
      const rpm = 42 + throttle * 26;               // idle → cruising firing rate
      engine.osc.frequency.setTargetAtTime(rpm, ctx.currentTime, 0.5);
      engine.sub.frequency.setTargetAtTime(rpm * 0.5, ctx.currentTime, 0.5);
    }
  }

  function setMuted(m) {
    muted = m;
    if (!ctx) { if (!m) start(); return; }           // first unmute also starts it
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.12, ctx.currentTime, muted ? 0.25 : 3.5);
  }

  return { start, setSpeed, setWind, setEnv, setHeel, setMuted, get muted() { return muted; } };
}

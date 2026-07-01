/* Procedural ambience (no audio files): a brackish-sea water bed with a slow
   washing swell, gentle wind, the boat's bow-wash rising with speed, and the
   occasional gull. Must be started from a user gesture (autoplay policy). */

export function createAudio() {
  let ctx = null, started = false;
  let master = null, waterWash = null, bowWash = null, windGain = null;
  let gullTimer = null;

  function brownNoise() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    return buf;
  }
  function loopNoise() { const s = ctx.createBufferSource(); s.buffer = brownNoise(); s.loop = true; s.start(); return s; }

  function start() {
    if (started) return; started = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();

    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);

    // calm sea bed — low broadband rumble
    const bed = loopNoise(); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 480; lp.Q.value = 0.3;
    const bedG = ctx.createGain(); bedG.gain.value = 0.32; bed.connect(lp); lp.connect(bedG); bedG.connect(master);

    // washing swell — band of higher noise, gain pulsed by a slow LFO
    const ws = loopNoise(); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 0.7;
    waterWash = ctx.createGain(); waterWash.gain.value = 0.14; ws.connect(bp); bp.connect(waterWash); waterWash.connect(master);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12; const lfoG = ctx.createGain(); lfoG.gain.value = 0.1;
    lfo.connect(lfoG); lfoG.connect(waterWash.gain); lfo.start();

    // bow wash — extra hiss that rises with boat speed
    const bs = loopNoise(); const bbp = ctx.createBiquadFilter(); bbp.type = 'bandpass'; bbp.frequency.value = 2600; bbp.Q.value = 0.5;
    bowWash = ctx.createGain(); bowWash.gain.value = 0.0; bs.connect(bbp); bbp.connect(bowWash); bowWash.connect(master);

    // wind — gentle, slowly breathing
    const wd = loopNoise(); const wbp = ctx.createBiquadFilter(); wbp.type = 'bandpass'; wbp.frequency.value = 720; wbp.Q.value = 0.4;
    windGain = ctx.createGain(); windGain.gain.value = 0.05; wd.connect(wbp); wbp.connect(windGain); windGain.connect(master);
    const wlfo = ctx.createOscillator(); wlfo.frequency.value = 0.06; const wlfoG = ctx.createGain(); wlfoG.gain.value = 0.035;
    wlfo.connect(wlfoG); wlfoG.connect(windGain.gain); wlfo.start();

    master.gain.linearRampToValueAtTime(0.72, ctx.currentTime + 3.0); // ease in
    scheduleGull();
  }

  function scheduleGull() {
    gullTimer = setTimeout(() => { if (ctx) { gull(); scheduleGull(); } }, 11000 + Math.random() * 17000);
  }

  // a short gull cry: 1–3 pitched "kyow"s through a bandpass, panned off to one side
  function gull() {
    const bus = ctx.createBiquadFilter(); bus.type = 'bandpass'; bus.frequency.value = 1900; bus.Q.value = 2.2;
    let out = bus;
    if (ctx.createStereoPanner) { const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8; bus.connect(pan); out = pan; }
    out.connect(master);
    const reps = 1 + Math.floor(Math.random() * 3);
    let t = ctx.currentTime + 0.05;
    for (let r = 0; r < reps; r++) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      const f = 880 + Math.random() * 320;
      o.frequency.setValueAtTime(f * 1.5, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.13);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.085, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      o.connect(g); g.connect(bus);
      o.start(t); o.stop(t + 0.27);
      t += 0.2 + Math.random() * 0.1;
    }
  }

  // boat speed (m/s) → bow wash level
  function setSpeed(spd) {
    if (!ctx || !bowWash) return;
    const target = Math.min(spd / 6.5, 1) * 0.16;
    bowWash.gain.setTargetAtTime(target, ctx.currentTime, 0.5);
  }

  return { start, setSpeed };
}

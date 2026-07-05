/* Ambience: calm and lovely — the sailing-boat recording (freesound, CC0)
   warmed through a low-pass so the hiss is gone, kept quiet, breathing on a
   slow swell, over a soft synthesized water-lap bed. Starts MUTED; the 🔇
   button turns it on (autoplay policy also requires a user gesture). */

export function createAudio() {
  let ctx = null, started = false, muted = true;
  let master = null, speedGain = null;

  function brownNoise() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    return buf;
  }

  async function start() {
    if (started) return; started = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    speedGain = ctx.createGain();
    speedGain.gain.value = 0.55;
    speedGain.connect(master);

    try {
      const buf = await (await fetch(import.meta.env.BASE_URL + 'sailing-ambience.mp3')).arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.loop = true;
      src.loopStart = 0.5;
      src.loopEnd = audio.duration - 0.5;
      // warm it down: low-pass takes out the harsh wind hiss, leaves the water
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 680; lp.Q.value = 0.4;
      const recGain = ctx.createGain(); recGain.gain.value = 0.62;
      src.connect(lp); lp.connect(recGain); recGain.connect(speedGain);
      // a slow swell so it breathes instead of droning
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.12;
      lfo.connect(lfoG); lfoG.connect(recGain.gain); lfo.start();
      src.start();
    } catch (e) {
      console.warn('ambience failed to load', e);
    }

    // soft lapping bed under the recording — gentle, low, unhurried
    const lapSrc = ctx.createBufferSource();
    lapSrc.buffer = brownNoise(); lapSrc.loop = true;
    const lapBp = ctx.createBiquadFilter();
    lapBp.type = 'bandpass'; lapBp.frequency.value = 420; lapBp.Q.value = 0.6;
    const lapGain = ctx.createGain(); lapGain.gain.value = 0.07;
    lapSrc.connect(lapBp); lapBp.connect(lapGain); lapGain.connect(master);
    const lapLfo = ctx.createOscillator(); lapLfo.frequency.value = 0.11;
    const lapLfoG = ctx.createGain(); lapLfoG.gain.value = 0.045;
    lapLfo.connect(lapLfoG); lapLfoG.connect(lapGain.gain);
    lapLfo.start(); lapSrc.start();

    if (!muted) master.gain.linearRampToValueAtTime(0.7, ctx.currentTime + 3.0);
  }

  // boat speed (m/s) → a whisper of extra water, never louder than calm
  function setSpeed(spd) {
    if (!ctx || !speedGain) return;
    speedGain.gain.setTargetAtTime(0.55 + Math.min(spd / 6.5, 1) * 0.15, ctx.currentTime, 0.8);
  }

  function setMuted(m) {
    muted = m;
    if (!ctx) { if (!m) start(); return; }           // first unmute also starts it
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, ctx.currentTime, 0.2);
  }

  return { start, setSpeed, setMuted, get muted() { return muted; } };
}

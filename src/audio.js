/* Ambience: a real sailing-boat recording (freesound community, CC0), looped
   through WebAudio with a gentle speed-reactive lift and a mute toggle.
   Must be started from a user gesture (autoplay policy).
   SOUND IS OPT-IN: starts muted; the 🔇 button turns it on. */

export function createAudio() {
  let ctx = null, started = false, muted = true;
  let master = null, speedGain = null;

  async function start() {
    if (started) return; started = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    speedGain = ctx.createGain();
    speedGain.gain.value = 0.85;
    speedGain.connect(master);

    try {
      const buf = await (await fetch(import.meta.env.BASE_URL + 'sailing-ambience.mp3')).arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.loop = true;
      // loop away from the file's edges so the seam doesn't click
      src.loopStart = 0.5;
      src.loopEnd = audio.duration - 0.5;
      src.connect(speedGain);
      src.start();
    } catch (e) {
      console.warn('ambience failed to load', e);
    }
    if (!muted) master.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 2.5); // ease in
  }

  // boat speed (m/s) → a subtle lift, like the water working harder
  function setSpeed(spd) {
    if (!ctx || !speedGain) return;
    speedGain.gain.setTargetAtTime(0.85 + Math.min(spd / 6.5, 1) * 0.3, ctx.currentTime, 0.6);
  }

  function setMuted(m) {
    muted = m;
    if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.15);
  }

  return { start, setSpeed, setMuted, get muted() { return muted; } };
}

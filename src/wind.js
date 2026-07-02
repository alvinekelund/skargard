/* Seeded gust field: puffs every 8–25 s with a smoothstep attack (1.5–4 s), a
   short plateau and a slower release — asymmetry is what reads as weather.
   Each gust also veers the wind ±5–12°, so a dead run can turn into an
   accidental gybe with no input at all (the honest kind of drama). */

const DEG = Math.PI / 180;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth01 = (x) => { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); };

export function createGustField(seed = 1337) {
  const rand = mulberry32(seed);
  let g = null;                        // active gust
  let next = 6 + rand() * 8;           // first puff 6–14 s in
  const out = { env: 0, envRate: 0, veer: 0, texture: 0 };

  function update(t, dt) {
    if (!g && t >= next) {
      const ramp = 1.5 + rand() * 2.5;                    // 1.5–4 s attack
      g = {
        t0: t, ramp,
        hold: 1.0 + rand() * 2.0,                         // 1–3 s plateau
        decay: ramp * 1.6,                                // dies slower than it hits
        strength: 0.25 + rand() * 0.20,                   // +25–45 %
        veer: (5 + rand() * 7) * DEG * (rand() < 0.5 ? -1 : 1), // ±5–12°
      };
    }
    let env = 0;
    if (g) {
      const e = t - g.t0;
      if (e < g.ramp) env = smooth01(e / g.ramp);
      else if (e < g.ramp + g.hold) env = 1;
      else if (e < g.ramp + g.hold + g.decay) env = 1 - smooth01((e - g.ramp - g.hold) / g.decay);
      else { g = null; next = t + 8 + rand() * 17; }      // 8–25 s spacing
    }
    out.envRate = dt > 0 ? (env - out.env) / dt : 0;
    out.env = env * (g ? 1 : 0);
    out.strength = g ? g.strength : 0;
    out.veer = (g ? g.veer : 0) * out.env;                // veer rides the envelope
    // fine texture so the plateau isn't a flat shelf (±4 %, incommensurate sines)
    out.texture = 0.04 * Math.sin(t * 5.7 + 1.3) * Math.sin(t * 1.9) + 0.02 * Math.sin(t * 11.3);
    return out;
  }
  return { update };
}

// Seeded PRNG + 2D simplex noise + fbm — shared across the world generator.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeNoise2D(seed) {
  const p = new Uint8Array(512), src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;
  const rng = mulberry32(seed);
  for (let i = 255; i > 0; i--) { const r = Math.floor(rng() * (i + 1)); const t = src[i]; src[i] = src[r]; src[r] = t; }
  for (let i = 0; i < 512; i++) p[i] = src[i & 255];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  const g = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  return function (xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1; if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const gi0 = p[ii + p[jj]] % 8, gi1 = p[ii + i1 + p[jj + j1]] % 8, gi2 = p[ii + 1 + p[jj + 1]] % 8;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0; if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * (g[gi0][0] * x0 + g[gi0][1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1; if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * (g[gi1][0] * x1 + g[gi1][1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2; if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * (g[gi2][0] * x2 + g[gi2][1] * y2); }
    return 70 * (n0 + n1 + n2); // ~[-1, 1]
  };
}

// fractal brownian motion over a given 2D noise function
export function makeFbm(noise2d) {
  return function (x, y, oct = 4, lac = 2.0, gain = 0.5) {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) { sum += amp * noise2d(x * freq, y * freq); norm += amp; amp *= gain; freq *= lac; }
    return sum / norm; // ~[-1, 1]
  };
}

import * as THREE from 'three';

/* Real aerial imagery draped on the terrain. Per streamed region we work out
   which Web-Mercator tiles cover the water around the boat, fetch them from a
   live tile server (Esri World Imagery — global, CORS-enabled, no key), and
   composite them into one canvas texture. The island shader samples it by
   world position, so the granite wears the real satellite photo of that exact
   place. Tiles are cached, so sailing on only fetches the new edge.

   Imagery © Esri, Maxar, Earthstar Geographics — shown as attribution in-game.
   Projection matches the bake: x=(lon−21.49)·111320·cos(59.805°), z=−(lat−59.805)·111320. */

const LAT0 = 59.805, LON0 = 21.49;
const M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const M_LAT = 111320;
const worldToLon = (x) => LON0 + x / M_LON;
const worldToLat = (z) => LAT0 - z / M_LAT;
const lonToWorld = (lon) => (lon - LON0) * M_LON;
const latToWorld = (lat) => -(lat - LAT0) * M_LAT;

const lon2tile = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2tile = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z;
};
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// z16 is ~1.2 m/pixel at 60°N: enough to preserve street edges, individual
// roofs, small fields and exposed granite seams. z15 blurred those into 2–3 m
// colour blocks, so the supposedly measured terrain still read procedural.
export function createSatellite({ zoom = 16, half = 1800, canvasSize = 3072 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = canvasSize;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#223038'; ctx.fillRect(0, 0, canvasSize, canvasSize);

  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Canvas row 0 is north, while WebGL v=0 is the texture's lower edge. Keep
  // Three's default vertical upload flip so shader v=0 samples that north row.
  // Disabling it mirrored every aerial mosaic north↔south against the DEM,
  // roads and buildings despite all sources using the same coordinates.
  texture.flipY = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const box = new THREE.Vector4(0, 0, 1, 1);   // world x0, z0, w, h — the shader's UV frame
  const cache = new Map();                     // "x/y" → HTMLImageElement | null
  let token = 0;
  let ready = false;
  let readyKey = '';
  let pendingKey = '';
  let pendingPromise = null;
  const classCache = new Map();
  const frameKey = (cx, cz) => `${Math.round(cx)},${Math.round(cz)}`;

  function fetchTile(tx, ty) {
    const key = tx + '/' + ty;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { cache.set(key, img); resolve(img); };
      img.onerror = () => { cache.set(key, null); resolve(null); };
      img.src = TILE_URL(zoom, tx, ty);
    });
  }

  // rebuild the composite for a region centred on world (cx, cz)
  async function update(cx, cz) {
    const key = frameKey(cx, cz);
    if (readyKey === key) return true;
    if (pendingKey === key && pendingPromise) return pendingPromise;
    pendingKey = key;
    pendingPromise = assemble(cx, cz, key);
    return pendingPromise;
  }

  async function assemble(cx, cz, key) {
    const my = ++token;
    const x0 = cx - half, z0 = cz - half, span = half * 2;
    // Compose offscreen. The currently displayed texture and its coordinate
    // box remain a matched pair until every replacement tile is present.
    const work = document.createElement('canvas');
    work.width = work.height = canvasSize;
    const wctx = work.getContext('2d');
    wctx.fillStyle = '#223038'; wctx.fillRect(0, 0, canvasSize, canvasSize);

    const lonMin = worldToLon(x0), lonMax = worldToLon(x0 + span);
    const latN = worldToLat(z0), latS = worldToLat(z0 + span);   // z0 (min z) is north
    const txMin = Math.floor(lon2tile(lonMin, zoom)), txMax = Math.floor(lon2tile(lonMax, zoom));
    const tyMin = Math.floor(lat2tile(latN, zoom)), tyMax = Math.floor(lat2tile(latS, zoom));

    const jobs = [];
    for (let tx = txMin; tx <= txMax; tx++)
      for (let ty = tyMin; ty <= tyMax; ty++)
        jobs.push({ tx, ty, img: fetchTile(tx, ty) });

    const pxOf = (wx) => (wx - x0) / span * canvasSize;
    const pyOf = (wz) => (wz - z0) / span * canvasSize;

    let drewAny = false;
    for (const j of jobs) {
      const img = await j.img;
      if (my !== token) return;                 // a newer region superseded us
      if (!img) continue;
      const px0 = pxOf(lonToWorld(tile2lon(j.tx, zoom)));
      const px1 = pxOf(lonToWorld(tile2lon(j.tx + 1, zoom)));
      const py0 = pyOf(latToWorld(tile2lat(j.ty, zoom)));
      const py1 = pyOf(latToWorld(tile2lat(j.ty + 1, zoom)));
      wctx.drawImage(img, px0, py0, px1 - px0, py1 - py0);
      drewAny = true;
    }
    // Upload once after the complete mosaic is assembled. Updating the GPU for
    // every one of 20–30 tiles caused visible checkerboard construction and a
    // large startup hitch at the exact moment terrain was streaming in.
    if (drewAny && my === token) {
      ctx.clearRect(0, 0, canvasSize, canvasSize);
      ctx.drawImage(work, 0, 0);
      box.set(x0, z0, span, span);
      texture.needsUpdate = true;
      ready = true;
      readyKey = key;
      classCache.clear();
    }
    if (pendingKey === key) { pendingKey = ''; pendingPromise = null; }
    return drewAny && my === token;
  }

  // Classify the already-downloaded aerial image at its native ~1.2 m scale.
  // A 3x3 mean suppresses single-pixel shadows; 4 m cache cells keep the tens
  // of thousands of vegetation probes cheap during a region build.
  function sampleClass(x, z) {
    if (!ready || x < box.x || z < box.y || x >= box.x + box.z || z >= box.y + box.w) return null;
    const ck = `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
    if (classCache.has(ck)) return classCache.get(ck);
    const px = Math.round((x - box.x) / box.z * canvasSize);
    const py = Math.round((z - box.y) / box.w * canvasSize);
    const sx = Math.max(0, Math.min(canvasSize - 3, px - 1));
    const sy = Math.max(0, Math.min(canvasSize - 3, py - 1));
    const d = ctx.getImageData(sx, sy, 3, 3).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    r /= 9; g /= 9; b /= 9;
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const mx = Math.max(rf, gf, bf), mn = Math.min(rf, gf, bf), delta = mx - mn;
    const sat = mx ? delta / mx : 0;
    let hue = 0;
    if (delta) {
      if (mx === rf) hue = (60 * ((gf - bf) / delta)) % 360;
      else if (mx === gf) hue = 60 * ((bf - rf) / delta) + 120;
      else hue = 60 * ((rf - gf) / delta) + 240;
      if (hue < 0) hue += 360;
    }
    let cl;
    if (mx < 0.14 || (b > g && b > r && mx < 0.30)) cl = 0;       // water
    else if (sat < 0.17 && mx > 0.30) cl = 3;                      // rock/roof
    else if (hue >= 85) cl = mx < 0.42 ? (sat >= 0.24 && hue >= 96 ? 1 : 4) : 2;
    else if (hue >= 60) cl = mx < 0.28 && sat > 0.34 ? 1 : mx > 0.46 && sat > 0.25 ? 2 : 4;
    else cl = sat < 0.20 && mx > 0.40 ? 3 : mx < 0.16 ? 0 : 4;
    classCache.set(ck, cl);
    return cl;
  }

  return { texture, box, update, sampleClass, hasFrame: (cx, cz) => readyKey === frameKey(cx, cz), get ready() { return ready; } };
}

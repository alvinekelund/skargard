/* Minimal Nordic HUD: speed/heading/point-of-sail block, wind+heading compass
   with gust flare, sail-trim / throttle bar, engine chip, location line, and a
   clear controls legend. */

const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function createHUD() {
  const root = document.createElement('div');
  root.className = 'hud';
  root.innerHTML = `
    <div class="hud-readout">
      <div class="hud-speed"><span class="num">0.0</span><span class="unit">kn</span></div>
      <div class="hud-hdg"><span class="deg">000°</span> <span class="card">N</span></div>
      <div class="hud-pos">—</div>
      <div class="hud-trim">
        <span class="trim-label">TRIM</span>
        <span class="trim-track"><span class="trim-fill"></span></span>
      </div>
      <div class="hud-motor">⏻ ENGINE <span class="thr">0%</span></div>
      <div class="hud-loc">—</div>
    </div>
    <div class="hud-controls">
      <b>←→</b> steer · <b>↑↓</b> <span class="ctl-trim">trim sail</span> · <b>E</b> engine · <b>C</b> camera · <b>M</b> chart · <b>T</b> time · <b>I</b> data
    </div>`;
  document.body.appendChild(root);

  // ── data-provenance panel (D): what in view is real data vs procedural ──
  const dataPanel = document.createElement('div');
  dataPanel.style.cssText = [
    'position:fixed', 'top:216px', 'right:16px', 'max-width:340px', 'padding:12px 14px',   // below the minimap
    'background:rgba(8,14,20,0.82)', 'border:1px solid rgba(255,255,255,0.14)', 'border-radius:6px',
    'font:11px/1.65 ui-monospace,monospace', 'color:rgba(255,255,255,0.85)', 'display:none',
    'z-index:30', 'pointer-events:none', 'white-space:pre-wrap',
  ].join(';');
  document.body.appendChild(dataPanel);

  function setDebug(info) {
    if (!info) { dataPanel.style.display = 'none'; return; }
    const sw = (c) => `<span style="color:${c}">■</span>`;
    dataPanel.innerHTML =
      `<b style="letter-spacing:0.08em">DATA IN THIS REGION</b>\n` +
      `<b style="color:#9fd8a4">real (OSM / EU-DEM)</b>\n` +
      `${sw('#2fd6c4')}${sw('#ff9b45')} ${info.islands} island outlines — all real OSM coastline\n` +
      `${sw('#2fd6c4')} elevation measured on ${info.measured} (${info.gridded} with interior relief grid, EU-DEM ~25 m)\n` +
      `${sw('#ff9b45')} ${info.islands - info.measured} skerries below raster resolution → procedural height\n` +
      `${sw('#46d95e')} ${info.wood} wood ${sw('#c46bd4')} ${info.heath} heath ${sw('#e0cf4a')} ${info.scrub} scrub polygons drive ground + trees\n` +
      `· buildings ${info.buildings}/${info.buildingsTotal} · pier segments ${info.pierSegs}/${info.pierSegsTotal} · seamarks ${info.seamarks}/${info.seamarksTotal} — rendered / in region data (render caps 350/380/90)\n` +
      `<b style="color:#f0b28a">procedural</b>\n` +
      `· island height PROFILES between shore and peak · bathymetry\n` +
      `· rock texture, tree/boulder models + placement (inside real polygons)\n` +
      `· water, waves, weather`;
    dataPanel.style.display = 'block';
  }

  // ── compass ──
  const wrap = document.createElement('div');
  wrap.className = 'hud-compass';
  root.appendChild(wrap);
  const R = 64, cx = 72, cy = 72;
  const svg = el('svg', { viewBox: '0 0 144 144', width: 144, height: 144 }, wrap);
  el('circle', { cx, cy, r: R, fill: 'rgba(10,16,24,0.38)', stroke: 'rgba(255,255,255,0.18)', 'stroke-width': 1.2 }, svg);
  el('circle', { cx, cy, r: R - 10, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }, svg);

  const dial = el('g', {}, svg);
  const marks = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
  for (const [lbl, deg] of marks) {
    const a = deg * Math.PI / 180;
    const x = cx + Math.sin(a) * (R - 6), y = cy - Math.cos(a) * (R - 6);
    const t = el('text', { x, y: y + 4, 'text-anchor': 'middle', fill: lbl === 'N' ? '#ffcaa0' : 'rgba(255,255,255,0.55)', 'font-size': 11, 'font-family': 'ui-monospace, monospace' }, dial);
    t.textContent = lbl;
  }
  for (let d = 0; d < 360; d += 30) {
    const a = d * Math.PI / 180;
    const r1 = R - 1, r2 = d % 90 === 0 ? R - 12 : R - 7;
    el('line', { x1: cx + Math.sin(a) * r1, y1: cy - Math.cos(a) * r1, x2: cx + Math.sin(a) * r2, y2: cy - Math.cos(a) * r2, stroke: 'rgba(255,255,255,0.25)', 'stroke-width': 1 }, dial);
  }

  // wind arrow (rotates to wind bearing relative to boat); flares amber in gusts
  const windG = el('g', {}, svg);
  const windArrow = el('path', { d: `M ${cx} ${cy - R + 4} l 6 12 l -6 -4 l -6 4 z`, fill: '#7fc4ff' }, windG);
  const windShaft = el('line', { x1: cx, y1: cy - R + 16, x2: cx, y2: cy - 8, stroke: 'rgba(127,196,255,0.5)', 'stroke-width': 2 }, windG);

  // fixed boat marker (always points up = boat heading)
  el('path', { d: `M ${cx} ${cy - 16} l 8 22 l -8 -6 l -8 6 z`, fill: '#fff', stroke: 'rgba(0,0,0,0.3)', 'stroke-width': 0.5 }, svg);
  const windKn = el('text', { x: cx, y: cy + 28, 'text-anchor': 'middle', fill: 'rgba(255,255,255,0.72)', 'font-size': 13, 'font-weight': 600, 'font-family': 'ui-monospace, monospace' }, svg);
  windKn.textContent = '—';
  const windLbl = el('text', { x: cx, y: cy + 41, 'text-anchor': 'middle', fill: 'rgba(255,255,255,0.45)', 'font-size': 8, 'font-family': 'ui-monospace, monospace' }, svg);
  windLbl.textContent = 'KN WIND';

  const speedNum = root.querySelector('.hud-speed .num');
  const hdgDeg = root.querySelector('.hud-hdg .deg');
  const hdgCard = root.querySelector('.hud-hdg .card');
  const posLbl = root.querySelector('.hud-pos');
  const locLbl = root.querySelector('.hud-loc');
  const trimFill = root.querySelector('.trim-fill');
  const trimRow = root.querySelector('.hud-trim');
  const motorChip = root.querySelector('.hud-motor');
  const thrLbl = root.querySelector('.hud-motor .thr');
  const ctlTrim = root.querySelector('.ctl-trim');

  let lastLoc = '';
  function setLocation(name) {
    if (name === lastLoc) return;
    lastLoc = name;
    locLbl.textContent = name;
  }

  function update(state, wind) {
    // heading-up dial. Game convention: heading 0 = +Z = south, so bearing =
    // 180 − headingDeg. The dial must rotate by −bearing, and the wind marker
    // sits at the wind's FROM-bearing relative to the bow — both were mirrored
    // before, which made the wind seem to swing the wrong way through a turn.
    const headingDeg = (state.heading * 180 / Math.PI);
    dial.setAttribute('transform', `rotate(${headingDeg - 180} ${cx} ${cy})`);
    const windToDeg = Math.atan2(wind.dir.x, wind.dir.z) * 180 / Math.PI;
    windG.setAttribute('transform', `rotate(${headingDeg - windToDeg - 180} ${cx} ${cy})`);

    speedNum.textContent = (state.speed * 1.94384).toFixed(1);

    // compass heading (game world: heading 0 = +Z = "south" on our chart; convert to bearing)
    let brg = (180 - headingDeg) % 360; if (brg < 0) brg += 360;
    hdgDeg.textContent = String(Math.round(brg)).padStart(3, '0') + '°';
    hdgCard.textContent = CARDINALS[Math.round(brg / 45) % 8];

    // point of sail with luff/irons warning colours
    posLbl.textContent = state.pointOfSailName;
    posLbl.style.color = state.inIrons ? '#ff9a6b'
      : state.pointOfSailName === 'Luffing' ? '#ffd27f'
      : 'rgba(255,255,255,0.62)';

    // wind speed + gust flare
    const gust = wind.gust || 0;
    windKn.textContent = (wind.speed * 16).toFixed(0);
    windKn.setAttribute('fill', gust > 0.25 ? '#ffd27f' : 'rgba(255,255,255,0.72)');
    windArrow.setAttribute('fill', gust > 0.25 ? '#ffd27f' : '#7fc4ff');
    windShaft.setAttribute('stroke-width', (2 + 2.5 * gust).toFixed(2));

    // trim bar ↔ throttle bar
    if (state.motorOn) {
      trimRow.querySelector('.trim-label').textContent = 'THROTTLE';
      trimFill.style.width = `${Math.round(state.throttle * 100)}%`;
      trimFill.style.background = '#ffb35c';
      motorChip.style.display = 'block';
      thrLbl.textContent = `${Math.round(state.throttle * 100)}%`;
      ctlTrim.textContent = 'throttle';
    } else {
      trimRow.querySelector('.trim-label').textContent = 'TRIM';
      trimFill.style.width = `${Math.round((1 - state.sheet) * 100)}%`;   // sheeted in = full bar
      trimFill.style.background = state.flap > 0.12 ? '#ffd27f' : '#7fc4ff';
      motorChip.style.display = 'none';
      ctlTrim.textContent = 'trim sail';
    }
  }

  return { root, update, setLocation, setDebug };
}

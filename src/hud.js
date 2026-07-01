/* Minimal Nordic HUD: a wind/heading compass, speed, point of sail, controls. */

const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

export function createHUD() {
  const root = document.createElement('div');
  root.className = 'hud';
  root.innerHTML = `
    <div class="hud-readout">
      <div class="hud-speed"><span class="num">0.0</span><span class="unit">kn</span></div>
      <div class="hud-pos">—</div>
      <div class="hud-loc">—</div>
    </div>
    <div class="hud-controls">
      <b>←&nbsp;→</b> steer&nbsp;&nbsp;·&nbsp;&nbsp;<b>↑&nbsp;↓</b> trim sail&nbsp;&nbsp;·&nbsp;&nbsp;<b>C</b> camera&nbsp;&nbsp;·&nbsp;&nbsp;<b>T</b> time of day
    </div>`;
  document.body.appendChild(root);

  // compass
  const wrap = document.createElement('div');
  wrap.className = 'hud-compass';
  root.appendChild(wrap);
  const R = 64, cx = 72, cy = 72;
  const svg = el('svg', { viewBox: '0 0 144 144', width: 144, height: 144 }, wrap);
  el('circle', { cx, cy, r: R, fill: 'rgba(10,16,24,0.38)', stroke: 'rgba(255,255,255,0.18)', 'stroke-width': 1.2 }, svg);
  el('circle', { cx, cy, r: R - 10, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }, svg);

  // rotating dial (cardinal marks) — rotates opposite heading so N stays north
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

  // wind indicator (arrow showing where the wind blows TO, rotates within dial frame)
  const windG = el('g', {}, svg);
  el('path', { d: `M ${cx} ${cy - R + 4} l 6 12 l -6 -4 l -6 4 z`, fill: '#7fc4ff' }, windG);
  el('line', { x1: cx, y1: cy - R + 16, x2: cx, y2: cy - 8, stroke: 'rgba(127,196,255,0.5)', 'stroke-width': 2 }, windG);

  // fixed boat marker (always points up = boat heading)
  el('path', { d: `M ${cx} ${cy - 16} l 8 22 l -8 -6 l -8 6 z`, fill: '#fff', stroke: 'rgba(0,0,0,0.3)', 'stroke-width': 0.5 }, svg);
  const windLbl = el('text', { x: cx, y: cy + 30, 'text-anchor': 'middle', fill: 'rgba(255,255,255,0.5)', 'font-size': 9, 'font-family': 'ui-monospace, monospace' }, svg);
  windLbl.textContent = 'WIND';

  const speedNum = root.querySelector('.hud-speed .num');
  const posLbl = root.querySelector('.hud-pos');
  const locLbl = root.querySelector('.hud-loc');
  let lastLoc = '';
  function setLocation(name) {
    if (name === lastLoc) return;
    lastLoc = name;
    locLbl.textContent = name;
  }

  function update(state, wind) {
    // heading up: rotate dial by -heading. heading is radians, 0 = +Z(south-ish); convert to compass deg
    const headingDeg = (state.heading * 180 / Math.PI);
    dial.setAttribute('transform', `rotate(${-headingDeg} ${cx} ${cy})`);
    // wind blows toward windDir; show its bearing relative to boat heading
    const windToDeg = Math.atan2(wind.dir.x, wind.dir.z) * 180 / Math.PI;
    windG.setAttribute('transform', `rotate(${windToDeg - headingDeg} ${cx} ${cy})`);
    speedNum.textContent = (state.speed * 1.94384).toFixed(1);
    posLbl.textContent = state.pointOfSailName;
    posLbl.style.color = state.inIrons ? '#ff9a6b' : 'rgba(255,255,255,0.62)';
  }

  return { root, update, setLocation };
}

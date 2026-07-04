/* ───────────────────────────────────────────────────────────────────────────
   Chart overlay — the whole real Archipelago Sea, Google-Maps style.
   Pan by dragging, zoom with the wheel, click open water to drop the boat
   there. Toggled with M.
   ─────────────────────────────────────────────────────────────────────────── */

export function createChart(mapData, { getBoat, onTeleport, realData = null, routes = null }) {
  const islands = mapData.islands.map((rec) => {
    const pts = rec.p;
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (const [x, z] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { p: pts, n: rec.n, a: rec.a, minX, minZ, maxX, maxZ };
  });
  const big = islands.filter((i) => i.n && i.a > 200000);

  // overlay DOM
  const root = document.createElement('div');
  root.style.cssText = `position:fixed;inset:0;z-index:30;display:none;
    background:rgba(6,12,18,0.55);backdrop-filter:blur(3px);`;
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;';
  root.appendChild(cv);
  const hint = document.createElement('div');
  hint.style.cssText = `position:absolute;left:50%;bottom:26px;transform:translateX(-50%);
    font:11px ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;
    color:rgba(255,255,255,.75);background:rgba(8,14,22,.6);padding:8px 18px;border-radius:18px;`;
  hint.textContent = 'drag to pan · scroll to zoom · click open water to sail there · M to close';
  root.appendChild(hint);
  document.body.appendChild(root);

  const ctx = cv.getContext('2d');
  // view: world metres → screen px
  const view = { cx: 0, cz: 0, ppm: 0.012 };   // ~83 m/px, whole chart visible
  let open = false;

  function resize() {
    cv.width = innerWidth * devicePixelRatio;
    cv.height = innerHeight * devicePixelRatio;
  }
  addEventListener('resize', () => { if (open) { resize(); draw(); } });

  const sx = (wx) => (wx - view.cx) * view.ppm * devicePixelRatio + cv.width / 2;
  const sz = (wz) => (wz - view.cz) * view.ppm * devicePixelRatio + cv.height / 2;
  const wx = (px) => (px * devicePixelRatio - cv.width / 2) / (view.ppm * devicePixelRatio) + view.cx;
  const wz = (pz) => (pz * devicePixelRatio - cv.height / 2) / (view.ppm * devicePixelRatio) + view.cz;

  function draw() {
    const W = cv.width, H = cv.height, k = view.ppm * devicePixelRatio;
    ctx.fillStyle = '#16323e';                     // chart sea
    ctx.fillRect(0, 0, W, H);
    // graticule every 5 km
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    const step = 5000 * k;
    for (let x = (W / 2 - view.cx * k) % step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = (H / 2 - view.cz * k) % step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    ctx.fillStyle = '#7c8464';                     // land
    ctx.strokeStyle = '#a9ad8c'; ctx.lineWidth = Math.max(1, k * 18);
    for (const isl of islands) {
      const x0 = sx(isl.minX), x1 = sx(isl.maxX);
      if (x1 < 0 || x0 > W) continue;
      const z0 = sz(isl.minZ), z1 = sz(isl.maxZ);
      if (z1 < 0 || z0 > H) continue;
      if (x1 - x0 < 1.4 && z1 - z0 < 1.4) {        // sub-pixel skerry → dot
        ctx.fillRect(x0, z0, 1.2, 1.2);
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(sx(isl.p[0][0]), sz(isl.p[0][1]));
      for (let i = 1; i < isl.p.length; i++) ctx.lineTo(sx(isl.p[i][0]), sz(isl.p[i][1]));
      ctx.closePath(); ctx.fill();
    }

    // ferry lanes: the real routes the traffic sails, as faint dashed tracks
    if (routes) {
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = devicePixelRatio;
      ctx.setLineDash([6 * devicePixelRatio, 7 * devicePixelRatio]);
      for (const key of ['viking', 'roadferry', 'utoline']) {   // silja ≈ viking at chart scale
        const r = routes[key];
        if (!r) continue;
        ctx.beginPath();
        ctx.moveTo(sx(r[0][0]), sz(r[0][1]));
        for (let i = 1; i < r.length; i++) ctx.lineTo(sx(r[i][0]), sz(r[i][1]));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // zoomed in, the chart grows granular: charted seamarks, piers, buildings
    if (realData && k > 0.018) {
      const inView = (x, z) => { const px = sx(x), pz = sz(z); return px > -20 && px < W + 20 && pz > -20 && pz < H + 20; };
      if (k > 0.045) {
        ctx.fillStyle = '#5c4432';                                 // piers
        for (const line of realData.piers) {
          for (const [px, pz] of line) if (inView(px, pz)) ctx.fillRect(sx(px) - 1, sz(pz) - 1, 2.5 * devicePixelRatio, 2.5 * devicePixelRatio);
        }
        ctx.fillStyle = '#7e3b2d';                                 // buildings → villages emerge
        for (const [bx2, bz2] of realData.buildings) {
          if (inView(bx2, bz2)) ctx.fillRect(sx(bx2) - 1, sz(bz2) - 1, 2 * devicePixelRatio, 2 * devicePixelRatio);
        }
      }
      const MARK = { 0: '#e05a3a', 1: '#3fae5a', 6: '#e8e6df', 7: '#ffcf66' };
      for (const [mx2, mz2, tt] of realData.seamarks) {            // the fairway system
        if (!inView(mx2, mz2)) continue;
        const px = sx(mx2), pz = sz(mz2), r2 = 2.2 * devicePixelRatio;
        if (tt >= 2 && tt <= 5) {                                  // cardinals: yellow/black
          ctx.fillStyle = '#1c1c1c'; ctx.fillRect(px - r2 / 2 - 1, pz - r2 / 2 - 1, r2 + 2, r2 + 2);
          ctx.fillStyle = '#e8c520'; ctx.fillRect(px - r2 / 2, pz - r2 / 2, r2, r2);
        } else {
          ctx.fillStyle = MARK[tt] || '#e8e6df';
          ctx.beginPath(); ctx.arc(px, pz, r2 * 0.7, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // names appear as you zoom in (bigger islands first)
    ctx.font = `${11 * devicePixelRatio}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,250,235,0.8)';
    ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 4;
    for (const isl of islands) {
      if (!isl.n) continue;
      const px = (isl.maxX - isl.minX) * k;
      if (px < 30) continue;
      const cxp = sx((isl.minX + isl.maxX) / 2), czp = sz((isl.minZ + isl.maxZ) / 2);
      if (cxp < -100 || cxp > W + 100 || czp < -50 || czp > H + 50) continue;
      ctx.fillText(isl.n, cxp, czp);
    }
    ctx.shadowBlur = 0;

    // Utö lighthouse mark
    const uto = big.find((i) => i.n === 'Utö');
    if (uto) {
      const ux = sx((uto.minX + uto.maxX) / 2), uz = sz((uto.minZ + uto.maxZ) / 2);
      ctx.strokeStyle = '#e05a3a'; ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath(); ctx.arc(ux, uz, 6 * devicePixelRatio, 0, Math.PI * 2); ctx.stroke();
    }

    // the boat
    const b = getBoat();
    const bx = sx(b.pos.x), bz = sz(b.pos.z);
    ctx.save();
    ctx.translate(bx, bz);
    ctx.rotate(Math.atan2(Math.sin(b.heading), Math.cos(b.heading)) * -1 + Math.PI);
    ctx.fillStyle = '#ffb35c';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = devicePixelRatio;
    ctx.beginPath();
    const s = 9 * devicePixelRatio;
    ctx.moveTo(0, -s); ctx.lineTo(s * 0.62, s); ctx.lineTo(-s * 0.62, s); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();

    // scale bar
    const km = 5000 * k;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(W - km - 40, H - 34, km, 3 * devicePixelRatio);
    ctx.font = `${10 * devicePixelRatio}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'right';
    ctx.fillText('5 km', W - 44, H - 44);
  }

  function pointOnLand(x, z) {
    for (const isl of islands) {
      if (x < isl.minX - 30 || x > isl.maxX + 30 || z < isl.minZ - 30 || z > isl.maxZ + 30) continue;
      let inside = false;
      const r = isl.p;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (((r[i][1] > z) !== (r[j][1] > z)) &&
            (x < (r[j][0] - r[i][0]) * (z - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  // interactions
  let dragging = false, moved = 0, lx = 0, ly = 0;
  cv.addEventListener('pointerdown', (e) => { dragging = true; moved = 0; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    moved += Math.abs(dx) + Math.abs(dy);
    view.cx -= dx / view.ppm / 1; view.cz -= dy / view.ppm / 1;
    lx = e.clientX; ly = e.clientY;
    draw();
  });
  cv.addEventListener('pointerup', (e) => {
    dragging = false;
    if (moved < 6) {                                // a click, not a drag
      const tx = wx(e.clientX), tz = wz(e.clientY);
      if (!pointOnLand(tx, tz)) {
        onTeleport(tx, tz);
        toggle(false);
      } else {
        hint.textContent = 'that’s land — click open water · M to close';
        setTimeout(() => { hint.textContent = 'drag to pan · scroll to zoom · click open water to sail there · M to close'; }, 1600);
      }
    }
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.pow(1.15, -Math.sign(e.deltaY));
    const ax = wx(e.clientX), az = wz(e.clientY);
    view.ppm = Math.min(2, Math.max(0.004, view.ppm * f));
    // keep the point under the cursor fixed
    view.cx = ax - (e.clientX * devicePixelRatio - cv.width / 2) / (view.ppm * devicePixelRatio);
    view.cz = az - (e.clientY * devicePixelRatio - cv.height / 2) / (view.ppm * devicePixelRatio);
    draw();
  }, { passive: false });

  function toggle(force) {
    open = force !== undefined ? force : !open;
    root.style.display = open ? 'block' : 'none';
    if (open) {
      resize();
      const b = getBoat();
      view.cx = b.pos.x; view.cz = b.pos.z;
      if (view.ppm < 0.01) view.ppm = 0.05;        // arrive zoomed to ~20 m/px region
      draw();
    }
  }

  // ── always-on corner minimap: north-up, boat-centred, click to open the chart ──
  const MINI = 188;                                 // css px
  const dpr = devicePixelRatio;
  const mini = document.createElement('canvas');
  mini.width = MINI * dpr; mini.height = MINI * dpr;
  mini.style.cssText = `position:fixed;top:16px;right:16px;width:${MINI}px;height:${MINI}px;
    border-radius:10px;border:1px solid rgba(255,255,255,0.16);z-index:20;cursor:pointer;
    box-shadow:0 2px 14px rgba(0,0,0,0.35);`;
  mini.title = 'open the chart (M)';
  mini.addEventListener('click', () => toggle(true));
  document.body.appendChild(mini);
  const mtx = mini.getContext('2d');
  const MPPM = (MINI * dpr) / 4200;                 // ~4.2 km across

  function updateMini() {
    if (open) return;                               // the full chart supersedes it
    const b = getBoat();
    const W = mini.width, H = mini.height;
    const msx = (x) => (x - b.pos.x) * MPPM + W / 2;
    const msz = (z) => (z - b.pos.z) * MPPM + H / 2;
    mtx.fillStyle = '#16323e';
    mtx.fillRect(0, 0, W, H);
    mtx.fillStyle = '#7c8464';
    const R = 2400;                                 // world metres shown (with margin)
    for (const isl of islands) {
      if (isl.maxX < b.pos.x - R || isl.minX > b.pos.x + R ||
          isl.maxZ < b.pos.z - R || isl.minZ > b.pos.z + R) continue;
      if ((isl.maxX - isl.minX) * MPPM < 1.5 && (isl.maxZ - isl.minZ) * MPPM < 1.5) {
        mtx.fillRect(msx(isl.minX), msz(isl.minZ), 1.4, 1.4);
        continue;
      }
      mtx.beginPath();
      mtx.moveTo(msx(isl.p[0][0]), msz(isl.p[0][1]));
      for (let i = 1; i < isl.p.length; i++) mtx.lineTo(msx(isl.p[i][0]), msz(isl.p[i][1]));
      mtx.closePath(); mtx.fill();
    }
    // charted seamarks — the minimap doubles as a pilotage chart
    if (realData) {
      const MMARK = { 0: '#e05a3a', 1: '#3fae5a', 6: '#e8e6df', 7: '#ffcf66' };
      for (const [mx2, mz2, tt] of realData.seamarks) {
        if (Math.abs(mx2 - b.pos.x) > R || Math.abs(mz2 - b.pos.z) > R) continue;
        mtx.fillStyle = tt >= 2 && tt <= 5 ? '#e8c520' : (MMARK[tt] || '#e8e6df');
        mtx.fillRect(msx(mx2) - dpr, msz(mz2) - dpr, 2 * dpr, 2 * dpr);
      }
    }

    // the boat: same bearing math as the chart marker
    mtx.save();
    mtx.translate(W / 2, H / 2);
    mtx.rotate(Math.PI - b.heading);
    mtx.fillStyle = '#ffb35c';
    mtx.strokeStyle = 'rgba(0,0,0,0.5)'; mtx.lineWidth = dpr;
    const s = 6 * dpr;
    mtx.beginPath();
    mtx.moveTo(0, -s); mtx.lineTo(s * 0.62, s); mtx.lineTo(-s * 0.62, s); mtx.closePath();
    mtx.fill(); mtx.stroke();
    mtx.restore();
    // N arrow + scale
    mtx.fillStyle = 'rgba(255,255,255,0.7)';
    mtx.font = `${9 * dpr}px ui-monospace, Menlo, monospace`;
    mtx.textAlign = 'left';
    mtx.fillText('N', 8 * dpr, 14 * dpr);
    mtx.fillRect(8 * dpr, H - 10 * dpr, 1000 * MPPM, 2 * dpr);
    mtx.fillText('1 km', 8 * dpr, H - 15 * dpr);
  }
  updateMini();

  return { toggle, updateMini, get open() { return open; } };
}

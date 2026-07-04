import * as THREE from 'three';
import { mulberry32 } from './noise.js';

/* ───────────────────────────────────────────────────────────────────────────
   Life for the archipelago, rebuilt with each streamed region:
   · IALA-A lateral spar buoys marking the channels between big islands
   · guest harbours (wooden dock, boathouse, moored rowboats) on named islands
   · red summer cottages (mökki) tucked along forested shores
   · distant sail traffic on the horizon, gulls working the harbours
   · Utö extras: pilot station + radar mast beside the lighthouse
   ─────────────────────────────────────────────────────────────────────────── */

const M = {
  sparRed: new THREE.MeshStandardMaterial({ color: 0xb5342a, roughness: 0.5 }),
  sparGreen: new THREE.MeshStandardMaterial({ color: 0x2c7a42, roughness: 0.5 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.85 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x5d452e, roughness: 0.9 }),
  falunRed: new THREE.MeshStandardMaterial({ color: 0x8a3326, roughness: 0.85 }),
  greyWall: new THREE.MeshStandardMaterial({ color: 0xb9b4a6, roughness: 0.85 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.6 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x39291f, roughness: 0.85 }),
  hullWhite: new THREE.MeshStandardMaterial({ color: 0xdfe2e4, roughness: 0.5 }),
  sail: new THREE.MeshStandardMaterial({ color: 0xf1eee6, roughness: 0.85, side: THREE.DoubleSide }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }),
  gull: new THREE.MeshBasicMaterial({ color: 0x1a1518, side: THREE.DoubleSide }),
  cardBlack: new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.5 }),
  cardYellow: new THREE.MeshStandardMaterial({ color: 0xe8c520, roughness: 0.5 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x33404a, roughness: 0.2, metalness: 0.4 }),
  navy: new THREE.MeshStandardMaterial({ color: 0x24466e, roughness: 0.55 }),
};
// shared across region rebuilds — the streaming dispose pass must skip these
Object.values(M).forEach((m) => { m.__shared = true; });

function sparBuoy(green) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 2.6, 7), green ? M.sparGreen : M.sparRed);
  body.position.y = 0.9; g.add(body);
  const top = green
    ? new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 7), M.sparGreen)
    : new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.36, 7), M.sparRed);
  top.position.y = 2.35; g.add(top);
  g.rotation.z = 0.05; g.rotation.x = 0.04;
  return g;
}

function rowboat(rng) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 2.6, 3, 7), rng() < 0.5 ? M.hullWhite : M.falunRed);
  hull.scale.set(1, 0.42, 1);
  hull.rotation.x = Math.PI / 2; hull.rotation.z = Math.PI / 2;
  hull.position.y = 0.16; g.add(hull);
  return g;
}

// a small open motorboat (~5 m) — flattened hull, console + windscreen, outboard.
// bow at +Z so heading = rotation.y matches the movement convention.
function motorboat(rng) {
  const g = new THREE.Group();
  const hullMat = [M.hullWhite, M.falunRed, M.white, M.navy][Math.floor(rng() * 4)];
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(0.72, 3.4, 4, 9), hullMat);
  hull.scale.set(1, 0.62, 0.5);          // (width, length, draft) after the tip below
  hull.rotation.x = Math.PI / 2;         // long axis → +Z
  hull.position.y = 0.32; g.add(hull);
  const well = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.34, 2.0), M.woodDark);
  well.position.set(0, 0.5, -0.3); g.add(well);                    // dark cockpit
  const cons = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 0.65), M.white);
  cons.position.set(0, 0.72, 0.2); g.add(cons);                    // console
  const ws = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.42, 0.04), M.glass);
  ws.position.set(0, 1.0, -0.02); ws.rotation.x = 0.35; g.add(ws); // raked windscreen
  const ob = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.72, 0.34), M.steel);
  ob.position.set(0, 0.32, -1.9); g.add(ob);                       // outboard at the transom
  return g;
}

function house(rng, big = false) {
  const g = new THREE.Group();
  const red = rng() < 0.75;
  const w = (big ? 4.4 : 2.6) + rng() * 1.2, d = (big ? 6.5 : 3.6) + rng() * 1.6, h = (big ? 3 : 1.7) + rng() * 0.5;
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), red ? M.falunRed : M.greyWall);
  body.position.y = h / 2; g.add(body);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.001, Math.hypot(w, d) * 0.44, h * 0.7, 4), M.roof);
  roof.rotation.y = Math.PI / 4; roof.position.y = h + h * 0.35; g.add(roof);
  return g;
}

function dock(len) {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.18, len), M.wood);
  deck.position.set(0, 0.55, -len / 2); g.add(deck);
  for (let i = 0; i < Math.floor(len / 3); i++) {
    const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.7, 5), M.woodDark);
    pile.position.set(0.85 * (i % 2 ? 1 : -1), -0.2, -1.4 - i * 3);
    g.add(pile);
  }
  return g;
}

function distantSailboat() {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 4.2), M.hullWhite);
  hull.position.y = 0.25; g.add(hull);
  const sailShape = new THREE.Shape();
  sailShape.moveTo(0, 0); sailShape.lineTo(0, 5.4); sailShape.lineTo(2.1, 0.3); sailShape.closePath();
  const sail = new THREE.Mesh(new THREE.ShapeGeometry(sailShape), M.sail);
  sail.position.set(0, 0.6, 0.4); g.add(sail);
  return g;
}

function gull() {
  const g = new THREE.Group();
  const wing = () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.quadraticCurveTo(0.5, 0.16, 1.05, 0.02); s.quadraticCurveTo(0.5, -0.05, 0, -0.07);
    return new THREE.Mesh(new THREE.ShapeGeometry(s), M.gull);
  };
  const L = wing(), R = wing();
  R.scale.x = -1;
  g.add(L, R);
  g.userData = { L, R };
  return g;
}

export function buildProps({ activeSet, islandHeight, heightAt, center, region = {} }) {
  const group = new THREE.Group();
  const rng = mulberry32(Math.floor(center.x * 13 + center.y * 7) ^ 0x5eed);
  const dyn = { buoys: [], traffic: [], gulls: [], moored: [], smallCraft: [] };

  const big = activeSet.filter((i) => i.A > 40000);

  // ── the REAL charted seamarks (OSM seamark:* = the actual fairway system) ──
  // 0 port-red · 1 stbd-green · 2-5 cardinals N/E/S/W · 6 special/danger · 7 light
  // IALA cardinal bands top→bottom, and double-cone topmarks:
  //   N black/yellow ▲▲ · E black/yellow/black ▲▼ · S yellow/black ▼▼ · W yellow/black/yellow ▼▲
  const B = M.cardBlack, Y = M.cardYellow;
  const CARD = {
    2: { bands: [B, Y], cones: [1, 1] },
    3: { bands: [B, Y, B], cones: [1, -1] },
    4: { bands: [Y, B], cones: [-1, -1] },
    5: { bands: [Y, B, Y], cones: [-1, 1] },
  };
  let marks = 0;
  for (const [mx, mz, tt] of (region.seamarks || [])) {
    if (marks >= 90) break;
    if (heightAt(mx, mz) > -0.8) continue;               // keep marks off the rocks
    let m;
    if (tt === 0 || tt === 1) m = sparBuoy(tt === 1);
    else if (tt >= 2 && tt <= 5) {
      m = new THREE.Group();
      const { bands, cones } = CARD[tt];
      const H = 2.6, bh = H / bands.length;
      bands.forEach((mat, bi) => {
        const y0 = H - bh * (bi + 0.5);                  // bands listed top→bottom
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.11 + bi * 0.012, 0.115 + bi * 0.012, bh, 7), mat);
        seg.position.y = y0;
        m.add(seg);
      });
      cones.forEach((dir, ci) => {                       // topmarks are always black
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.26, 7), M.cardBlack);
        cone.position.y = H + 0.5 - ci * 0.34;
        if (dir < 0) cone.rotation.x = Math.PI;
        m.add(cone);
      });
    } else if (tt === 7) {
      m = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 3.4, 7), M.white);
      post.position.y = 1.4;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xfff2cf, emissive: 0xffcf66, emissiveIntensity: 1.4 }));
      lamp.position.y = 3.3;
      m.add(post, lamp);
    } else {
      m = sparBuoy(false);
      m.children[0].material = M.white;
    }
    m.position.set(mx, 0, mz);
    group.add(m);
    dyn.buoys.push(m);
    marks++;
  }

  // ── the REAL buildings (OSM footprints: position, size, orientation, class) ──
  let placed = 0;
  for (const [bx, bz, bw, bd, ang, cls] of (region.buildings || [])) {
    if (placed >= 350) break;
    const ground = heightAt(bx, bz);
    if (ground < -1.2) continue;                          // skip footprints over open water
    const rng2 = mulberry32(Math.floor(bx * 7 + bz * 13));
    const h = cls === 2 ? 5.5 : cls === 1 ? 2.1 : 2.9;
    const wall = cls === 2 ? M.white : (rng2() < 0.72 ? M.falunRed : (rng2() < 0.5 ? M.greyWall : M.white));
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(bw, h, bd), wall);
    body.position.y = h / 2; g.add(body);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.001, Math.hypot(bw, bd) * 0.42, h * 0.55, 4), M.roof);
    roof.rotation.y = Math.PI / 4; roof.position.y = h + h * 0.27; g.add(roof);
    g.position.set(bx, Math.max(ground, 0.25) - 0.06, bz);
    g.rotation.y = ang;
    group.add(g);
    placed++;
  }

  // ── the REAL piers (OSM man_made=pier polylines) ──
  let segs = 0;
  for (const line of (region.piers || [])) {
    if (segs >= 380) break;
    for (let i = 0; i < line.length - 1 && segs < 380; i++) {
      const [x1, z1] = line[i], [x2, z2] = line[i + 1];
      const L = Math.hypot(x2 - x1, z2 - z1);
      if (L < 0.8 || L > 120) continue;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, L), M.wood);
      seg.position.set((x1 + x2) / 2, 0.55, (z1 + z2) / 2);
      seg.rotation.y = Math.atan2(x2 - x1, z2 - z1);
      group.add(seg);
      segs++;
    }
  }

  // ── Utö extras: the pilot station + radar mast on the real island ──
  const uto = activeSet.find((i) => i.name === 'Utö');
  if (uto) {
    const urng = mulberry32(777);
    let hx = 0, hz = 0, hy = -1;
    for (let n = 0; n < 60; n++) {
      const lx = uto.bbox.minX + urng() * (uto.bbox.maxX - uto.bbox.minX);
      const lz = uto.bbox.minZ + urng() * (uto.bbox.maxZ - uto.bbox.minZ);
      const y = islandHeight(lx, lz, uto);
      if (y > hy) { hy = y; hx = lx; hz = lz; }
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 16, 6), M.steel);
    mast.position.set(uto.x + hx - 20, hy + 8, uto.z + hz - 8);
    group.add(mast);
    const radar = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), M.white);
    radar.position.set(uto.x + hx - 20, hy + 16.4, uto.z + hz - 8);
    group.add(radar);
  }

  // ── distant sail traffic ──
  for (let n = 0; n < 2; n++) {
    const ang = rng() * Math.PI * 2, dist = 1300 + rng() * 900;
    const x = center.x + Math.sin(ang) * dist, z = center.y + Math.cos(ang) * dist;
    if (heightAt(x, z) > -3) continue;
    const tb = distantSailboat();
    tb.position.set(x, 0, z);
    tb.userData = { heading: rng() * Math.PI * 2, speed: 1.2 + rng() * 0.8 };
    tb.rotation.y = tb.userData.heading;
    group.add(tb);
    dyn.traffic.push(tb);
  }

  // ── gulls working the lighthouse / first harbour / open sky ──
  const roost = uto ? { x: uto.x, z: uto.z } : { x: center.x, z: center.y };
  for (let n = 0; n < 6; n++) {
    const bird = gull();
    const sc = 1.2 + rng() * 1.4;
    bird.scale.setScalar(sc);
    bird.userData = {
      ...bird.userData,
      cx: roost.x + (rng() - 0.5) * 300, cz: roost.z + (rng() - 0.5) * 300,
      r: 30 + rng() * 70, h: 18 + rng() * 26,
      w: (0.25 + rng() * 0.2) * (rng() < 0.5 ? 1 : -1),
      phase: rng() * Math.PI * 2, flap: 5 + rng() * 3,
    };
    group.add(bird);
    dyn.gulls.push(bird);
  }

  // ── small boats moored off the real piers (harbours) ──
  let moored = 0;
  for (const line of (region.piers || [])) {
    if (moored >= 7) break;
    let best = null, bd = 0;                       // seaward pier end = deepest water
    for (const [px, pz] of line) { const d = -heightAt(px, pz); if (d > bd) { bd = d; best = [px, pz]; } }
    if (!best || bd < 0.7) continue;
    const [px, pz] = best;
    let dx = px - line[0][0], dz = pz - line[0][1];
    const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;   // outward along the pier
    const b = rng() < 0.55 ? motorboat(rng) : rowboat(rng);
    b.position.set(px + dx * 3.5, 0, pz + dz * 3.5);
    b.rotation.y = Math.atan2(dx, dz) + (rng() - 0.5) * 0.4;
    group.add(b);
    dyn.moored.push(b);
    moored++;
  }

  // ── a few small boats puttering around the region's open water ──
  for (let n = 0; n < 3; n++) {
    const ang = rng() * Math.PI * 2, dist = 250 + rng() * 650;
    const x = center.x + Math.sin(ang) * dist, z = center.y + Math.cos(ang) * dist;
    if (heightAt(x, z) > -2) continue;
    const b = motorboat(rng);
    b.position.set(x, 0, z);
    b.userData = { heading: rng() * Math.PI * 2, speed: 2.4 + rng() * 3.2, turn: 0, side: rng() < 0.5 ? 1 : -1, phase: rng() * 6.28 };
    b.rotation.y = b.userData.heading;
    group.add(b);
    dyn.smallCraft.push(b);
  }

  group.traverse((o) => { if (o.isMesh && o.material !== M.gull && o.material !== M.sail) { o.castShadow = true; o.receiveShadow = true; } });

  function update(dt, t, waveHeightAt) {
    for (const b of dyn.buoys) {
      b.position.y = (waveHeightAt ? waveHeightAt(b.position.x, b.position.z, t) : 0) * 0.85;
      b.rotation.z = 0.05 + Math.sin(t * 0.9 + b.position.x) * 0.05;
    }
    for (const tb of dyn.traffic) {
      const u = tb.userData;
      tb.position.x += Math.sin(u.heading) * u.speed * dt;
      tb.position.z += Math.cos(u.heading) * u.speed * dt;
      tb.position.y = (waveHeightAt ? waveHeightAt(tb.position.x, tb.position.z, t) : 0) * 0.8;
      tb.rotation.z = Math.sin(t * 0.6 + u.phase || 0) * 0.06 - 0.12;
    }
    for (const bird of dyn.gulls) {
      const u = bird.userData;
      const a = u.phase + t * u.w;
      bird.position.set(u.cx + Math.cos(a) * u.r, u.h + Math.sin(t * 0.4 + u.phase) * 2.5, u.cz + Math.sin(a) * u.r);
      bird.rotation.y = -a - Math.PI / 2 * Math.sign(u.w);
      const f = Math.sin(t * u.flap + u.phase) * 0.55;
      u.L.rotation.y = f; u.R.rotation.y = -f;
    }
    for (const b of dyn.moored) {                    // ride the swell at anchor
      b.position.y = (waveHeightAt ? waveHeightAt(b.position.x, b.position.z, t) : 0) * 0.9;
      b.rotation.z = Math.sin(t * 0.7 + b.position.x) * 0.05;
    }
    for (const b of dyn.smallCraft) {                // putter about, turning off the land
      const u = b.userData;
      const ax = b.position.x + Math.sin(u.heading) * 45, az = b.position.z + Math.cos(u.heading) * 45;
      if (heightAt(ax, az) > -1.5) u.turn = Math.min(u.turn + dt, 0.6); else u.turn *= 0.9;
      u.heading += u.turn * u.side * dt;
      b.position.x += Math.sin(u.heading) * u.speed * dt;
      b.position.z += Math.cos(u.heading) * u.speed * dt;
      b.position.y = (waveHeightAt ? waveHeightAt(b.position.x, b.position.z, t) : 0) * 0.85;
      b.rotation.y = u.heading;
      b.rotation.z = Math.sin(t * 1.3 + u.phase) * 0.05 - u.turn * u.side * 0.15;
    }
  }

  return { group, update, counts: { seamarks: marks, buildings: placed, pierSegs: segs } };
}

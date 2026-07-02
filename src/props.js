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

export function buildProps({ activeSet, islandHeight, heightAt, center }) {
  const group = new THREE.Group();
  const rng = mulberry32(Math.floor(center.x * 13 + center.y * 7) ^ 0x5eed);
  const dyn = { buoys: [], traffic: [], gulls: [] };

  const big = activeSet.filter((i) => i.A > 40000);

  // ── lateral marks in the channels between big islands ──
  let buoyCount = 0;
  for (let a = 0; a < big.length && buoyCount < 14; a++) {
    for (let b = a + 1; b < big.length && buoyCount < 14; b++) {
      const A = big[a], B = big[b];
      const dx = B.x - A.x, dz = B.z - A.z;
      const gap = Math.hypot(dx, dz) - (A.R + B.R);
      if (gap < 60 || gap > 700) continue;
      const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2;
      if (heightAt(mx, mz) > -2.5) continue;                     // needs real water
      const green = (buoyCount % 2) === 0;
      const buoy = sparBuoy(green);
      buoy.position.set(mx, 0, mz);
      group.add(buoy);
      dyn.buoys.push(buoy);
      buoyCount++;
    }
  }

  // ── harbours + cottages on the named/forested islands ──
  let harbours = 0;
  const settled = activeSet.filter((i) => (i.name && i.A > 120000) || (i.kind === 'forest' && i.A > 200000));
  for (const isl of settled.slice(0, 6)) {
    const irng = mulberry32(Math.floor(isl.x * 31 + isl.z * 17));
    // find a shore vertex with deep water just outside
    let shore = null, out = null;
    for (let n = 0; n < 30 && !shore; n++) {
      const v = isl.ring[Math.floor(irng() * isl.ring.length)];
      const vx = isl.x + v[0], vz = isl.z + v[1];
      const away = Math.atan2(vx - isl.x, vz - isl.z);
      const ox = vx + Math.sin(away) * 14, oz = vz + Math.cos(away) * 14;
      if (heightAt(ox, oz) < -1.6 && islandHeight(v[0], v[1], isl) > -0.6) { shore = [vx, vz]; out = away; }
    }
    if (!shore) continue;

    if (harbours < 2 && isl.name && irng() < 0.8) {
      // a small guest harbour: dock running out to sea + boathouse + rowboats
      const d = dock(11 + irng() * 6);
      d.position.set(shore[0], 0, shore[1]);
      d.rotation.y = out + Math.PI;                              // deck runs seaward
      group.add(d);
      const bh = house(irng, false);
      const bx = shore[0] - Math.sin(out) * 7, bz = shore[1] - Math.cos(out) * 7;
      bh.position.set(bx, Math.max(islandHeight(bx - isl.x, bz - isl.z, isl), 0.3), bz);
      bh.rotation.y = out;
      group.add(bh);
      const rb = rowboat(irng);
      rb.position.set(shore[0] + Math.sin(out + 1.4) * 3.4, 0, shore[1] + Math.cos(out + 1.4) * 3.4);
      rb.rotation.y = out + 0.4;
      group.add(rb);
      dyn.buoys.push(rb);                                        // bobs like a buoy
      harbours++;
    } else if (isl.kind === 'forest' && irng() < 0.75) {
      // a summer cottage clearing
      for (let c = 0, placed = 0; c < 40 && placed < 2; c++) {
        const lx = isl.bbox.minX + irng() * (isl.bbox.maxX - isl.bbox.minX);
        const lz = isl.bbox.minZ + irng() * (isl.bbox.maxZ - isl.bbox.minZ);
        const y = islandHeight(lx, lz, isl);
        if (y < 1.0 || y > 3.2) continue;
        const c1 = house(irng, false);
        c1.position.set(isl.x + lx, y - 0.08, isl.z + lz);
        c1.rotation.y = irng() * Math.PI * 2;
        group.add(c1);
        placed++;
      }
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
    const pilot = house(urng, true);
    pilot.traverse((o) => { if (o.isMesh && o.material === M.falunRed) o.material = M.white; });
    pilot.position.set(uto.x + hx + 26, Math.max(hy - 0.6, 0.4), uto.z + hz + 14);
    group.add(pilot);
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
  }

  return { group, update };
}

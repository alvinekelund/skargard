import * as THREE from 'three';

/* Live running rigging: small verlet ropes simulated in the BOAT's local frame.
   Gravity is the world's down-vector transformed into that frame each step, so
   every line hangs true and swings as she heels, pitches and rolls. The genoa
   sheets swap working/lazy sides with the tack; the mainsheet fall follows the
   boom out and back. Rendered as slim tubes, rebuilt per frame (tiny buffers). */

const DAMP = 0.965;
const G = 6.5;                       // visual gravity — full 9.8 jitters at 60 fps
const SUBSTEP = 1 / 60;

class Rope {
  constructor(parent, mat, { n = 11, radius = 0.0075, slack = 1.1, collide = null }) {
    this.n = n; this.radius = radius; this.slack = slack; this.collide = collide;
    this.pts = []; this.prev = [];
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.castShadow = false; this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    this._inited = false;
    this._curvePts = [];
    for (let i = 0; i < n; i++) this._curvePts.push(new THREE.Vector3());
  }

  step(a, b, gLocal, jitter, t) {
    const n = this.n;
    if (!this._inited) {
      for (let i = 0; i < n; i++) {
        const p = new THREE.Vector3().lerpVectors(a, b, i / (n - 1));
        this.pts.push(p); this.prev.push(p.clone());
      }
      this._inited = true;
    }
    const rest = a.distanceTo(b) * this.slack / (n - 1);
    // verlet integrate the free points
    for (let i = 1; i < n - 1; i++) {
      const p = this.pts[i], pp = this.prev[i];
      const vx = (p.x - pp.x) * DAMP, vy = (p.y - pp.y) * DAMP, vz = (p.z - pp.z) * DAMP;
      pp.copy(p);
      const j = jitter * Math.sin(t * 7.3 + i * 1.7) * 0.5;
      p.x += vx + (gLocal.x + j) * SUBSTEP * SUBSTEP * 60;
      p.y += vy + gLocal.y * SUBSTEP * SUBSTEP * 60;
      p.z += vz + (gLocal.z + jitter * Math.cos(t * 5.1 + i * 2.3) * 0.5) * SUBSTEP * SUBSTEP * 60;
    }
    // pin ends, relax distance constraints, then push free points out of the boat
    // (collision) — interleaved so the rope settles ON the deck, not through it
    this.pts[0].copy(a); this.pts[n - 1].copy(b);
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < n - 1; i++) {
        const p = this.pts[i], q = this.pts[i + 1];
        const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const diff = (d - rest) / d * 0.5;
        const fa = i === 0 ? 0 : 1, fb = i + 1 === n - 1 ? 0 : 1;
        const w = fa + fb || 1;
        p.x += dx * diff * (2 * fa / w); p.y += dy * diff * (2 * fa / w); p.z += dz * diff * (2 * fa / w);
        q.x -= dx * diff * (2 * fb / w); q.y -= dy * diff * (2 * fb / w); q.z -= dz * diff * (2 * fb / w);
      }
      if (this.collide) for (let i = 1; i < n - 1; i++) this.collide(this.pts[i]);
    }
  }

  render() {
    for (let i = 0; i < this.n; i++) this._curvePts[i].copy(this.pts[i]);
    const curve = new THREE.CatmullRomCurve3(this._curvePts, false, 'catmullrom', 0.5);
    const geo = new THREE.TubeGeometry(curve, this.n * 2, this.radius, 5, false);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }
}

export function createRopes(swan, sailPivot) {
  const UP = new THREE.Vector3(0, 1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xcfc6ae, roughness: 0.95 });
  const matRed = new THREE.MeshStandardMaterial({ color: 0xb08a7a, roughness: 0.95 });

  // anchors in swan-local metres (+X bow, +Z stbd)
  const CLEW = new THREE.Vector3(0.55, 1.50, 0.0);
  const CAR_S = new THREE.Vector3(-0.88, 0.93, 1.17);
  const CAR_P = new THREE.Vector3(-0.88, 0.93, -1.17);
  const WINCH_S = new THREE.Vector3(-2.05, 1.13, 0.64);
  const WINCH_P = new THREE.Vector3(-2.05, 1.13, -0.64);
  const TRAV = new THREE.Vector3(-1.85, 1.07, 0);
  const BOOM_END = new THREE.Vector3(-3.47, 2.02, 0);   // sailPivot-local

  // keep a rope point out of the boat: rest it on the deck (the cockpit sole sits
  // lower), and push it up onto the coachroof or outboard of the cabin trunk
  // rather than letting it sink through the hull.
  function collide(p) {
    let floor = 0.9;                                                  // side/foredeck
    if (p.x > -3.4 && p.x < -1.5 && Math.abs(p.z) < 0.62) floor = 0.52; // cockpit sole
    if (p.y < floor) p.y = floor;
    // cabin trunk: x −1.25…2.35, half-width ~0.9, roof ~1.4 — evict from inside
    if (p.x > -1.25 && p.x < 2.35 && Math.abs(p.z) < 0.9 && p.y < 1.4) {
      if (1.4 - p.y <= 0.92 - Math.abs(p.z)) p.y = 1.4;              // up onto the roof
      else p.z = (p.z >= 0 ? 1 : -1) * 0.92;                        // out to the side deck
    }
  }

  const main = new Rope(swan, mat, { n: 9, radius: 0.008, slack: 1.05, collide });
  const sheetS1 = new Rope(swan, matRed, { n: 10, radius: 0.0075, slack: 1.02, collide });
  const sheetS2 = new Rope(swan, matRed, { n: 8, radius: 0.0075, slack: 1.02, collide });
  const sheetP1 = new Rope(swan, matRed, { n: 12, radius: 0.0075, slack: 1.3, collide });
  const sheetP2 = new Rope(swan, matRed, { n: 9, radius: 0.0075, slack: 1.22, collide });

  const _q = new THREE.Quaternion();
  const _g = new THREE.Vector3();
  const _a = new THREE.Vector3();

  // world down → swan-local, so ropes always hang toward the true horizon
  function update(dt, ctx) {
    swan.getWorldQuaternion(_q).invert();
    _g.set(0, -G, 0).applyQuaternion(_q);
    const jitter = 0.6 * (ctx.gust || 0) + 2.2 * (ctx.flap || 0);
    const t = ctx.t || 0;

    // boom end in swan-local: rotate by the trim pivot, then offset to the mast
    _a.copy(BOOM_END).applyAxisAngle(UP, sailPivot.rotation.y).add(sailPivot.position);
    main.step(_a, TRAV, _g, jitter, t);

    // the working sheet is hard; the lazy one droops across the foredeck
    const stbdWorking = ctx.side >= 0;
    sheetS1.slack = stbdWorking ? 1.015 : 1.30;
    sheetS2.slack = stbdWorking ? 1.01 : 1.20;
    sheetP1.slack = stbdWorking ? 1.30 : 1.015;
    sheetP2.slack = stbdWorking ? 1.20 : 1.01;
    sheetS1.step(CLEW, CAR_S, _g, jitter, t);
    sheetS2.step(CAR_S, WINCH_S, _g, jitter, t + 3);
    sheetP1.step(CLEW, CAR_P, _g, jitter, t + 5);
    sheetP2.step(CAR_P, WINCH_P, _g, jitter, t + 8);

    for (const r of [main, sheetS1, sheetS2, sheetP1, sheetP2]) r.render();
  }

  return { update };
}

import * as THREE from 'three';

/* A dynamic trailing foam ribbon laid on the water behind the boat, widening
   and fading astern. Driven by the stern position + boat speed each frame. */

function foamTexture() {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'); const img = ctx.createImageData(S, S);
  // value-noise froth
  const rnd = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0, amp = 0.55, f = 0.13;                 // start finer: froth, not giant blotches
    for (let o = 0; o < 4; o++) {
      const xi = Math.floor(x * f), yi = Math.floor(y * f);
      const fx = x * f - xi, fy = y * f - yi;
      const a = rnd(xi, yi), b = rnd(xi + 1, yi), c = rnd(xi, yi + 1), d = rnd(xi + 1, yi + 1);
      const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
      v += amp * (a * (1 - u) * (1 - w) + b * u * (1 - w) + c * (1 - u) * w + d * u * w);
      amp *= 0.55; f *= 2.3;
    }
    const i = (y * S + x) * 4; const c = Math.max(0, Math.min(1, (v - 0.4) / 0.38)) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = c;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

export function createWake(scene) {
  const MAX = 110;
  const pts = [];
  const positions = new Float32Array(MAX * 2 * 3);
  const uvs = new Float32Array(MAX * 2 * 2);
  const alphas = new Float32Array(MAX * 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  const idx = [];
  for (let i = 0; i < MAX - 1; i++) { const a = i*2, b = i*2+1, c = i*2+2, d = i*2+3; idx.push(a, b, c, b, d, c); }
  geo.setIndex(idx);

  // a real wake is a V: two frothy shoulder streaks off the quarters with a
  // softer churned band between them — not a uniform noisy smear
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: foamTexture() }, uTime: { value: 0 } },
    transparent: true, depthWrite: false,
    vertexShader: `attribute float aAlpha; varying float vA; varying vec2 vUv;
      void main(){ vA = aAlpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform float uTime; varying float vA; varying vec2 vUv;
      void main(){
        float lat = abs(vUv.x - 0.5) * 2.0;                       // 0 keel line → 1 edge
        float shoulder = smoothstep(0.42, 0.68, lat) * (1.0 - smoothstep(0.8, 1.0, lat)) * 1.3;
        float centre = (1.0 - smoothstep(0.0, 0.5, lat)) * 0.45;
        // vUv.y is metres along the trail — froth is anchored to the water,
        // two multiplied octaves so it breaks into fine foam, not blobs
        float f1 = texture2D(map, vec2(vUv.x * 1.8, vUv.y * 0.10 - uTime * 0.10)).a;
        float f2 = texture2D(map, vec2(vUv.x * 3.6 + 0.37, vUv.y * 0.21 + uTime * 0.05)).a;
        float froth = 0.35 + 0.9 * f1 * (0.4 + 0.6 * f2);
        float a = vA * (shoulder + centre) * froth;
        if (a < 0.012) discard;
        gl_FragColor = vec4(vec3(0.95,0.98,1.0), a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 3;
  scene.add(mesh);

  // wake reacts to speed AND turn: a hard turn throws a wider, brighter skidding
  // wash to the outside of the turn; the ribbon rides the wave surface.
  function update(state, fwd, t, waveH) {
    // the wake is born where the hull actually leaves the water — at the counter,
    // forward of the raked transom on a long-overhang boat — so it stays attached
    const off = 4.4;
    const sx = state.pos.x - fwd.x * off, sz = state.pos.z - fwd.z * off;
    const skidNow = THREE.MathUtils.clamp(state.turn || 0, 0, 1);
    const side = -Math.sign(state.yawRate || 0);     // wash to the outside of the turn
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(sx - last.x, sz - last.z) > 0.7) {
      const dist = last ? last.dist + Math.hypot(sx - last.x, sz - last.z) : 0;
      pts.push({ x: sx, z: sz, born: t, spd: state.speed, skid: skidNow, side, dist });
      if (pts.length > MAX) pts.shift();
    }
    const n = pts.length;
    const d0 = n ? pts[n - 1].dist : 0;
    for (let i = 0; i < MAX; i++) {
      const k = n - 1 - i;            // newest at i=0, oldest astern
      let cx = sx, cz = sz, px = 0, pz = 0, alpha = 0, vAlong = 0;
      if (i === 0) {
        // pin the freshest vertex to the LIVE stern (not the last stored point,
        // which lags up to a boat-length) so the foam never detaches from the hull
        cx = sx; cz = sz;
        px = -fwd.z; pz = fwd.x;                       // width axis = abeam
        const sp = THREE.MathUtils.clamp(state.speed / 4, 0, 1);
        const halfW = 0.72 * (0.45 + 0.75 * sp) * (1 + 0.8 * skidNow);
        alpha = state.speed > 0.05 ? Math.min(0.9, 0.4 + 0.55 * sp + 0.5 * skidNow) : 0;
        px *= halfW; pz *= halfW;
      } else if (k >= 0) {
        const p = pts[k];
        cx = p.x; cz = p.z;
        vAlong = d0 - p.dist;         // metres astern → texture rides the water
        const a = pts[Math.min(k + 1, n - 1)], b = pts[Math.max(k - 1, 0)];
        let tx = a.x - b.x, tz = a.z - b.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
        px = -tz; pz = tx;
        const age = t - p.born;
        const life = 6.0 + 2.5 * Math.min(p.spd / 4, 1) + 2.0 * p.skid;
        const fade = THREE.MathUtils.clamp(1 - age / life, 0, 1);
        const sp = THREE.MathUtils.clamp(p.spd / 4, 0, 1);
        // narrow at the transom, spreading gently astern — the classic V
        const halfW = (0.75 + i * 0.042) * (0.45 + 0.75 * sp) * (1 + 0.8 * p.skid);
        alpha = Math.min(0.9, Math.pow(fade, 1.5) * (0.3 + 0.58 * sp + 0.5 * p.skid));
        if (i < 3) alpha = Math.max(alpha, 0.55 * sp); // churned wash tight on the transom
        const shift = 0.35 * p.skid * halfW * p.side;  // skid wash eased outward, no jump
        cx += px * shift; cz += pz * shift;
        px *= halfW; pz *= halfW;
      }
      const y = (waveH ? waveH(cx, cz, t) : 0) + 0.06; // lie on the swell, not under it
      const vi = i * 2;
      positions[vi*3] = cx + px; positions[vi*3+1] = y; positions[vi*3+2] = cz + pz;
      positions[(vi+1)*3] = cx - px; positions[(vi+1)*3+1] = y; positions[(vi+1)*3+2] = cz - pz;
      uvs[vi*2] = 0; uvs[vi*2+1] = vAlong; uvs[(vi+1)*2] = 1; uvs[(vi+1)*2+1] = vAlong;
      alphas[vi] = alpha; alphas[vi+1] = alpha;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    mat.uniforms.uTime.value = t;
  }

  return { mesh, update };
}

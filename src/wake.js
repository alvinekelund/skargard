import * as THREE from 'three';

/* A dynamic trailing foam ribbon laid on the water behind the boat, widening
   and fading astern. Driven by the stern position + boat speed each frame. */

function foamTexture() {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'); const img = ctx.createImageData(S, S);
  // value-noise froth
  const rnd = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0, amp = 0.6, f = 0.06;
    for (let o = 0; o < 4; o++) {
      const xi = Math.floor(x * f), yi = Math.floor(y * f);
      const fx = x * f - xi, fy = y * f - yi;
      const a = rnd(xi, yi), b = rnd(xi + 1, yi), c = rnd(xi, yi + 1), d = rnd(xi + 1, yi + 1);
      const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
      v += amp * (a * (1 - u) * (1 - w) + b * u * (1 - w) + c * (1 - u) * w + d * u * w);
      amp *= 0.5; f *= 2.1;
    }
    const i = (y * S + x) * 4; const c = Math.max(0, Math.min(1, (v - 0.35) / 0.5)) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = c;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

export function createWake(scene) {
  const MAX = 90;
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

  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: foamTexture() }, uTime: { value: 0 } },
    transparent: true, depthWrite: false,
    vertexShader: `attribute float aAlpha; varying float vA; varying vec2 vUv;
      void main(){ vA = aAlpha; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform float uTime; varying float vA; varying vec2 vUv;
      void main(){
        float f = texture2D(map, vec2(vUv.x*1.5, vUv.y*6.0 - uTime*0.25)).a;
        float edge = smoothstep(0.0,0.22,vUv.x)*smoothstep(1.0,0.78,vUv.x);
        float a = vA * edge * (0.35 + 0.75*f);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.96,0.98,1.0), a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 3;
  scene.add(mesh);

  // wake reacts to speed AND turn: a hard turn throws a wider, brighter skidding
  // wash to the outside of the turn; the ribbon rides the wave surface.
  function update(state, fwd, t, waveH) {
    const off = 5.6;                                 // stern of the 11 m hull
    const sx = state.pos.x - fwd.x * off, sz = state.pos.z - fwd.z * off;
    const skidNow = THREE.MathUtils.clamp(state.turn || 0, 0, 1);
    const side = -Math.sign(state.yawRate || 0);     // wash to the outside of the turn
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(sx - last.x, sz - last.z) > 0.8) {
      pts.push({ x: sx, z: sz, born: t, spd: state.speed, skid: skidNow, side });
      if (pts.length > MAX) pts.shift();
    }
    const n = pts.length;
    for (let i = 0; i < MAX; i++) {
      const k = n - 1 - i;            // newest at i=0, oldest astern
      let cx = sx, cz = sz, px = 0, pz = 0, alpha = 0;
      if (k >= 0) {
        const p = pts[k];
        cx = p.x; cz = p.z;
        const a = pts[Math.min(k + 1, n - 1)], b = pts[Math.max(k - 1, 0)];
        let tx = a.x - b.x, tz = a.z - b.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
        px = -tz; pz = tx;
        const age = t - p.born;
        const life = 5.0 + 2.5 * Math.min(p.spd / 4, 1) + 2.0 * p.skid;
        const fade = THREE.MathUtils.clamp(1 - age / life, 0, 1);
        const sp = THREE.MathUtils.clamp(p.spd / 4, 0, 1);
        const halfW = (0.9 + i * 0.055) * (0.5 + 0.8 * sp) * (1 + 1.1 * p.skid);
        alpha = Math.min(0.95, fade * fade * (0.28 + 0.62 * sp + 0.55 * p.skid));
        const shift = 0.55 * p.skid * halfW * p.side; // skid wash pushed outward
        cx += px * shift; cz += pz * shift;
        px *= halfW; pz *= halfW;
      }
      const y = (waveH ? waveH(cx, cz, t) : 0) + 0.06; // lie on the swell, not under it
      const vi = i * 2;
      positions[vi*3] = cx + px; positions[vi*3+1] = y; positions[vi*3+2] = cz + pz;
      positions[(vi+1)*3] = cx - px; positions[(vi+1)*3+1] = y; positions[(vi+1)*3+2] = cz - pz;
      uvs[vi*2] = 0; uvs[vi*2+1] = i / MAX; uvs[(vi+1)*2] = 1; uvs[(vi+1)*2+1] = i / MAX;
      alphas[vi] = alpha; alphas[vi+1] = alpha;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    mat.uniforms.uTime.value = t;
  }

  return { mesh, update };
}

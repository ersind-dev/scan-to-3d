// Surface extraction (naive surface nets) and STL writing. No DOM here so it can be tested in Node.

export function otsu(data) {
  const h = new Float64Array(256);
  const stride = Math.max(1, Math.floor(data.length / 2e6));
  let n = 0;
  for (let i = 0; i < data.length; i += stride) { h[data[i]]++; n++; }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let wB = 0, sumB = 0, best = 0, thr = 64;
  for (let t = 0; t < 256; t++) {
    wB += h[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * h[t];
    const d = sumB / wB - (sum - sumB) / wF, v = wB * wF * d * d;
    if (v > best) { best = v; thr = t; }
  }
  return Math.max(4, Math.min(250, thr + 1));
}

// Average blocks down to at most `quality` samples per axis, with a one-sample empty border so surfaces close.
export function downsample(vol, quality, smooth) {
  const [nx, ny, nz] = vol.dims, d = vol.data;
  const f = [nx, ny, nz].map((n) => Math.max(1, Math.ceil(n / quality)));
  const m = [Math.max(1, Math.floor(nx / f[0])), Math.max(1, Math.floor(ny / f[1])), Math.max(1, Math.floor(nz / f[2]))];
  const gx = m[0] + 2, gy = m[1] + 2, gz = m[2] + 2;
  const g = new Float32Array(gx * gy * gz), inv = 1 / (f[0] * f[1] * f[2]);
  for (let z = 0; z < m[2]; z++) for (let y = 0; y < m[1]; y++) for (let x = 0; x < m[0]; x++) {
    let s = 0;
    for (let c = 0; c < f[2]; c++) for (let b = 0; b < f[1]; b++) {
      let o = x * f[0] + (y * f[1] + b) * nx + (z * f[2] + c) * nx * ny;
      for (let a = 0; a < f[0]; a++) s += d[o++];
    }
    g[x + 1 + (y + 1) * gx + (z + 1) * gx * gy] = s * inv;
  }
  if (smooth) {
    const strides = [1, gx, gx * gy], lens = [gx, gy, gz], tmp = new Float32Array(g.length);
    for (let ax = 0; ax < 3; ax++) {
      const st = strides[ax];
      tmp.set(g);
      for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
        const p = [x, y, z][ax];
        if (p === 0 || p === lens[ax] - 1) continue;
        const i = x + y * gx + z * gx * gy;
        g[i] = 0.25 * tmp[i - st] + 0.5 * tmp[i] + 0.25 * tmp[i + st];
      }
    }
  }
  // grid index -> original voxel index: (i - 1) * f + (f - 1) / 2
  return { grid: g, dims: [gx, gy, gz], factor: f };
}

export function surfaceNets(g, dims, iso) {
  const nx = dims[0], ny = dims[1], nz = dims[2], sxy = nx * ny;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1, cxy = cx * cy;
  const vidx = new Int32Array(cx * cy * cz).fill(-1);
  let pos = new Float32Array(3 * 65536), nv = 0;
  const off = new Int32Array(8), v = new Float32Array(8);
  for (let i = 0; i < 8; i++) off[i] = (i & 1) + ((i >> 1) & 1) * nx + ((i >> 2) & 1) * sxy;
  const ea = [], eb = [];
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) { ea.push(a); eb.push(a | bit); }

  for (let z = 0; z < cz; z++) for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
    const base = x + y * nx + z * sxy;
    let mask = 0;
    for (let i = 0; i < 8; i++) { const val = g[base + off[i]]; v[i] = val; if (val >= iso) mask |= 1 << i; }
    if (mask === 0 || mask === 255) continue;
    let px = 0, py = 0, pz = 0, n = 0;
    for (let e = 0; e < 12; e++) {
      const a = ea[e], b = eb[e];
      if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
      const t = (iso - v[a]) / (v[b] - v[a]);
      const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
      px += ax + t * ((b & 1) - ax); py += ay + t * (((b >> 1) & 1) - ay); pz += az + t * (((b >> 2) & 1) - az);
      n++;
    }
    if (nv * 3 + 3 > pos.length) { const p2 = new Float32Array(pos.length * 2); p2.set(pos); pos = p2; }
    pos[nv * 3] = x + px / n; pos[nv * 3 + 1] = y + py / n; pos[nv * 3 + 2] = z + pz / n;
    vidx[x + y * cx + z * cxy] = nv++;
  }

  let idx = new Uint32Array(6 * 65536), ni = 0;
  const gs = [1, nx, sxy], cs = [1, cx, cxy], lim = [cx, cy, cz], p = [0, 0, 0];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    p[0] = x; p[1] = y; p[2] = z;
    const i0 = x + y * nx + z * sxy, in0 = g[i0] >= iso;
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3, c = (a + 2) % 3;
      if (p[a] >= lim[a] || p[b] < 1 || p[c] < 1 || p[b] >= lim[b] || p[c] >= lim[c]) continue;
      if ((g[i0 + gs[a]] >= iso) === in0) continue;
      const cell = x + y * cx + z * cxy;
      const A = vidx[cell - cs[b] - cs[c]], B = vidx[cell - cs[c]], C = vidx[cell], D = vidx[cell - cs[b]];
      if (A < 0 || B < 0 || C < 0 || D < 0) continue;
      if (ni + 6 > idx.length) { const i2 = new Uint32Array(idx.length * 2); i2.set(idx); idx = i2; }
      if (in0) { idx[ni++] = A; idx[ni++] = B; idx[ni++] = C; idx[ni++] = A; idx[ni++] = C; idx[ni++] = D; }
      else { idx[ni++] = A; idx[ni++] = C; idx[ni++] = B; idx[ni++] = A; idx[ni++] = D; idx[ni++] = C; }
    }
  }
  return { positions: pos.slice(0, nv * 3), indices: idx.slice(0, ni) };
}

// Volume -> mesh in millimetres, centred on the volume centre.
export function buildSurface(vol, iso, quality, smooth) {
  const { grid, dims, factor } = downsample(vol, quality, smooth);
  const m = surfaceNets(grid, dims, iso);
  const p = m.positions;
  for (let a = 0; a < 3; a++) {
    const s = vol.spacing[a], f = factor[a], c = (vol.dims[a] - 1) / 2;
    for (let i = a; i < p.length; i += 3) p[i] = ((p[i] - 1) * f + (f - 1) / 2 - c) * s;
  }
  return m;
}

export function signedVolume(p, idx) {
  let vol = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return vol / 6;
}

// Binary STL, units = millimetres.
export function toSTL(p, idx) {
  const nt = idx.length / 3, buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
  const head = 'MRI surface model, units mm';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    dv.setFloat32(o, x, true); dv.setFloat32(o + 4, y, true); dv.setFloat32(o + 8, z, true); o += 12;
    for (const k of [a, b, c]) { dv.setFloat32(o, p[k], true); dv.setFloat32(o + 4, p[k + 1], true); dv.setFloat32(o + 8, p[k + 2], true); o += 12; }
    o += 2;
  }
  return buf;
}

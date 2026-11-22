// Reading scan files into a plain 8-bit volume: { dims, spacing (mm), data, orient }
import daikon from 'daikon';
import * as nifti from 'nifti-reader-js';
import { unzipSync } from 'fflate';

const MAX_VOXELS = 40e6;
const tick = () => new Promise((r) => setTimeout(r, 0));

function isZip(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return b.length === 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
function isGzip(buf) {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b.length === 2 && b[0] === 0x1f && b[1] === 0x8b;
}

// Map float samples to 0..255 using robust percentiles so a few hot pixels do not flatten the rest.
function toBytes(f) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < f.length; i++) { const v = f[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!(mx > mn)) return { data: new Uint8Array(f.length), lo: mn, hi: mx };
  const bins = 4096, hist = new Uint32Array(bins), k = (bins - 1) / (mx - mn);
  for (let i = 0; i < f.length; i++) hist[((f[i] - mn) * k) | 0]++;
  const pct = (p) => {
    const target = f.length * p; let acc = 0;
    for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc >= target) return mn + b / k; }
    return mx;
  };
  const lo = pct(0.001), hiRaw = pct(0.999), hi = hiRaw > lo ? hiRaw : mx;
  const s = 255 / (hi - lo), out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = (f[i] - lo) * s;
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }
  return { data: out, lo, hi };
}

function isImage(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);
}

// "axial_0012.jpg" -> { key: "axial", n: 12 }
function splitName(name) {
  const stem = name.replace(/\.[^.]+$/, '');
  const m = stem.match(/^(.*?)[\s_\-.]*(\d+)$/);
  return m ? { key: (m[1] || 'images').toLowerCase(), n: parseInt(m[2], 10) } : { key: stem.toLowerCase(), n: NaN };
}

function viewOf(key) {
  if (/sag/.test(key)) return 'sagittal';
  if (/cor/.test(key)) return 'coronal';
  if (/ax|trans/.test(key)) return 'axial';
  return null;
}

// Direction vectors in patient coordinates (x = patient left, y = back, z = head), matching DICOM.
// Images use the usual radiology display: patient's right on the image's left, front on the left in sagittal views.
const VIEW_DIRS = {
  axial: { r: [1, 0, 0], c: [0, 1, 0], s: [0, 0, -1] },    // numbered head -> feet
  sagittal: { r: [0, 1, 0], c: [0, 0, -1], s: [-1, 0, 0] }, // numbered patient's left -> right
  coronal: { r: [1, 0, 0], c: [0, 0, -1], s: [0, 1, 0] },   // numbered front -> back
};

function parseInfo(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z_]+)\s*[=:]\s*([0-9.]+)/i);
    if (m && isFinite(+m[2]) && +m[2] > 0) out[m[1].toLowerCase()] = +m[2];
  }
  return out;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const num = (v, d) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : d);

function dicomSeries(images) {
  const first = images[0];
  const rows = first.getRows(), cols = first.getCols();
  const frames = first.getNumberOfFrames() || 1;
  const multi = images.length === 1 && frames > 1;
  const count = multi ? frames : images.length;
  const desc = (first.getSeriesDescription() || '').trim() || 'Unnamed series';
  return {
    label: `${desc} · ${cols}×${rows}×${count}`,
    count,
    async build(progress) {
      const ps = first.getPixelSpacing() || [];
      const sy = num(ps[0], 1), sx = num(ps[1], sy);
      const thick = num(first.getSliceThickness(), 1) + (first.getSliceGap() > 0 ? first.getSliceGap() : 0);
      let sz = thick, orient = null, list = images;

      if (!multi) {
        const d = first.getImageDirections();
        let key = null;
        if (d && d.length === 6 && d.every(isFinite)) {
          const r = d.slice(0, 3), c = d.slice(3, 6), n = cross(r, c);
          if (images.every((im) => { const p = im.getImagePosition(); return p && p.length === 3 && p.every(isFinite); })) {
            key = (im) => dot(im.getImagePosition(), n);
            orient = [r, c, n];
          }
        }
        if (!key) key = (im) => im.getImageNumber() || 0;
        list = images.map((im) => ({ im, k: key(im) })).sort((a, b) => a.k - b.k);
        // drop repeats at the same position (repeat acquisitions in one series)
        if (orient) list = list.filter((e, i) => i === 0 || Math.abs(e.k - list[i - 1].k) > 1e-3);
        if (orient && list.length > 1) {
          const gaps = []; for (let i = 1; i < list.length; i++) gaps.push(list[i].k - list[i - 1].k);
          sz = num(median(gaps), thick);
        }
        list = list.map((e) => e.im);
      }

      const nz = multi ? frames : list.length;
      const step = cols * rows * nz > MAX_VOXELS ? 2 : 1;
      const nx = Math.floor(cols / step), ny = Math.floor(rows / step);
      const f = new Float32Array(nx * ny * nz);
      const all = multi ? first.getInterpretedData(false, false) : null;
      for (let z = 0; z < nz; z++) {
        const src = multi ? all.subarray(z * rows * cols, (z + 1) * rows * cols) : list[z].getInterpretedData(false, false);
        if (src.length < rows * cols) throw new Error('This series is not a greyscale image stack.');
        const o = z * nx * ny;
        if (step === 1) f.set(src.length === nx * ny ? src : src.subarray(0, nx * ny), o);
        else for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) f[o + y * nx + x] = src[y * step * cols + x * step];
        if ((z & 15) === 0) { progress && progress(z / nz); await tick(); }
      }
      const { data } = toBytes(f);
      return { dims: [nx, ny, nz], spacing: [sx * step, sy * step, sz], data, orient, label: this.label };
    },
  };
}

function niftiVolume(name, buf) {
  const h = nifti.readHeader(buf);
  const nx = h.dims[1], ny = h.dims[2], nz = Math.max(1, h.dims[3]);
  return {
    label: `${name} · ${nx}×${ny}×${nz}`,
    count: nz,
    async build() {
      const img = nifti.readImage(h, buf);
      const n = nx * ny * nz;
      const types = { 2: [Uint8Array, 'getUint8'], 4: [Int16Array, 'getInt16'], 8: [Int32Array, 'getInt32'], 16: [Float32Array, 'getFloat32'], 64: [Float64Array, 'getFloat64'], 256: [Int8Array, 'getInt8'], 512: [Uint16Array, 'getUint16'], 768: [Uint32Array, 'getUint32'] };
      const t = types[h.datatypeCode];
      if (!t) throw new Error('This NIfTI file uses a data type the app cannot read.');
      const bytes = t[0].BYTES_PER_ELEMENT;
      if (img.byteLength < n * bytes) throw new Error('This NIfTI file is shorter than its header says.');
      const f = new Float32Array(n);
      const slope = h.scl_slope && isFinite(h.scl_slope) ? h.scl_slope : 1, inter = isFinite(h.scl_inter) ? h.scl_inter : 0;
      if (h.littleEndian) { const a = new t[0](img.slice(0, n * bytes)); for (let i = 0; i < n; i++) f[i] = a[i] * slope + inter; }
      else { const dv = new DataView(img); for (let i = 0; i < n; i++) f[i] = dv[t[1]](i * bytes, false) * slope + inter; }
      const { data } = toBytes(f);
      const sp = [1, 2, 3].map((i) => num(Math.abs(h.pixDims[i]), 1));
      return { dims: [nx, ny, nz], spacing: sp, data, orient: null, label: this.label };
    },
  };
}

const IMG_BUDGET = 48e6;

// Max filter in place over a 0/1 mask, radius r, separable.
function dilate(m, w, h, r) {
  const t = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = m[y * w + k];
    t[y * w + x] = v;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let v = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = t[k * w + x];
    m[y * w + x] = v;
  }
}

function imageSeries(key, items, info, decoder) {
  items.sort((a, b) => (isFinite(a.n) && isFinite(b.n) ? a.n - b.n : a.name.localeCompare(b.name, undefined, { numeric: true })));
  const view = viewOf(key);
  const title = view ? view[0].toUpperCase() + view.slice(1) : key;
  return {
    label: `${title} images · ${items.length} slices`,
    count: items.length,
    isImages: true,
    params: { pixel: info.pixel_mm || 1, gap: (view && info[view + '_gap_mm']) || info.gap_mm || 1, fromInfo: !!info.pixel_mm },
    async build(progress) {
      if (!decoder) throw new Error('Image files can only be read in a browser.');
      const n = items.length;
      let order = items;
      let orient = null;
      if (view) {
        const d = VIEW_DIRS[view], nrm = cross(d.r, d.c);
        if (dot(nrm, d.s) < 0) order = [...items].reverse();
        orient = [d.r, d.c, nrm];
      }
      const size = await decoder.size(order[0].buffer);
      const scale = Math.min(1, Math.sqrt(IMG_BUDGET / (size.width * size.height * n)));
      const w = Math.max(1, Math.round(size.width * scale)), h = Math.max(1, Math.round(size.height * scale));
      const plane = w * h, all = new Uint8Array(plane * n), mask = new Uint8Array(plane);
      const r = Math.max(2, Math.round(6 * scale));
      let x0 = w, x1 = -1, y0 = h, y1 = -1;
      for (let z = 0; z < n; z++) {
        let rgba;
        try { rgba = await decoder.decode(order[z].buffer, w, h); }
        catch (e) { throw new Error(`Could not open image "${order[z].name}".`); }
        const o = z * plane;
        let coloured = false;
        for (let i = 0, j = 0; i < plane; i++, j += 4) {
          const R = rgba[j], G = rgba[j + 1], B = rgba[j + 2];
          const mx = R > G ? (R > B ? R : B) : (G > B ? G : B), mn = R < G ? (R < B ? R : B) : (G < B ? G : B);
          all[o + i] = (R * 77 + G * 150 + B * 29) >> 8;
          mask[i] = mx - mn > 28 ? 1 : 0;
          if (mask[i]) coloured = true;
        }
        // Coloured overlays (orientation icons, markers, annotations) are not scan data: blank them.
        if (coloured) { dilate(mask, w, h, r); for (let i = 0; i < plane; i++) if (mask[i]) all[o + i] = 0; }
        for (let y = 0; y < h; y++) {
          const row = o + y * w;
          for (let x = 0; x < w; x++) if (all[row + x] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if ((z & 7) === 0) { progress && progress(z / n); await tick(); }
      }
      if (x1 < 0) throw new Error('These images are completely dark.');
      x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(w - 1, x1 + 2); y1 = Math.min(h - 1, y1 + 2);
      const nx = x1 - x0 + 1, ny = y1 - y0 + 1, data = new Uint8Array(nx * ny * n);
      for (let z = 0; z < n; z++) for (let y = 0; y < ny; y++) {
        const src = z * plane + (y + y0) * w + x0;
        data.set(all.subarray(src, src + nx), (z * ny + y) * nx);
      }
      const p = this.params;
      return {
        dims: [nx, ny, n], data, orient, label: this.label,
        pxScale: [size.width / w, size.height / h],
        spacing: [p.pixel * size.width / w, p.pixel * size.height / h, p.gap],
      };
    },
  };
}

// files: [{ name, buffer }] -> { series: [{label, count, build}], skipped }
export async function readFiles(files, progress, decoder) {
  const queue = [];
  for (const f of files) {
    if (isZip(f.buffer)) {
      const entries = unzipSync(new Uint8Array(f.buffer));
      for (const name in entries) {
        const u = entries[name];
        if (u.length) queue.push({ name: name.split('/').pop(), buffer: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) });
      }
    } else queue.push(f);
  }
  const groups = new Map(), imgGroups = new Map(), series = [];
  let skipped = 0, info = {};
  for (let i = 0; i < queue.length; i++) {
    let { name, buffer } = queue[i];
    try {
      if (isGzip(buffer)) buffer = nifti.decompress(buffer);
      if (nifti.isNIFTI(buffer)) { series.push(niftiVolume(name, buffer)); continue; }
      if (isImage(buffer)) {
        const { key, n } = splitName(name);
        if (!imgGroups.has(key)) imgGroups.set(key, []);
        imgGroups.get(key).push({ name, n, buffer });
        continue;
      }
      if (/\.txt$/i.test(name) && buffer.byteLength < 4096) { Object.assign(info, parseInfo(new TextDecoder().decode(buffer))); continue; }
      const im = daikon.Series.parseImage(new DataView(buffer));
      if (im && im.hasPixelData() && im.getRows() > 0 && im.getCols() > 0) {
        const id = im.getSeriesId();
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(im);
      } else skipped++;
    } catch (e) { skipped++; }
    if ((i & 31) === 0) { progress && progress(i / queue.length); await tick(); }
  }
  for (const imgs of groups.values()) series.push(dicomSeries(imgs));
  for (const [key, items] of imgGroups) if (items.length >= 2) series.push(imageSeries(key, items, info, decoder)); else skipped++;
  series.sort((a, b) => b.count - a.count);
  return { series, skipped };
}

// A made-up head-like shape so the app has something to show before any scan is loaded.
export function samplePhantom() {
  const nx = 112, ny = 128, nz = 72, sp = [1.6, 1.6, 2.4];
  const data = new Uint8Array(nx * ny * nz);
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const ell = (x, y, z, c, r) => ((x - c[0]) / r[0]) ** 2 + ((y - c[1]) / r[1]) ** 2 + ((z - c[2]) / r[2]) ** 2;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = (i - nx / 2) * sp[0], y = (j - ny / 2) * sp[1], z = (k - nz / 2) * sp[2];
    let v = 6;
    const head = ell(x, y, z, [0, 0, 0], [72, 88, 76]);
    const nose = ell(x, y, z, [0, -90, -14], [11, 16, 15]);
    if (head < 1 || nose < 1) {
      v = 190;
      if (ell(x, y, z, [0, 0, 4], [65, 81, 69]) < 1) v = 40;
      if (ell(x, y, z, [0, 0, 4], [60, 76, 64]) < 1) {
        v = 120 + 22 * Math.sin(x / 7) * Math.cos(y / 9) * Math.sin(z / 8);
        if (ell(x, y, z, [14, 6, 10], [9, 26, 10]) < 1 || ell(x, y, z, [-14, 6, 10], [9, 26, 10]) < 1) v = 28;
        if (ell(x, y, z, [22, 30, -18], [13, 13, 13]) < 1) v = 225;
      }
    }
    data[i + j * nx + k * nx * ny] = Math.max(0, Math.min(255, v + (rnd() - 0.5) * 14));
  }
  return { dims: [nx, ny, nz], spacing: sp, data, orient: null, label: 'Sample shape (not a real scan)' };
}

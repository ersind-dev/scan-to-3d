import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { zipSync } from 'fflate';
import { readFiles, samplePhantom } from './volume.js';
import { buildSurface, otsu, toSTL } from './mesh.js';

const $ = (id) => document.getElementById(id);
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
camera.up.set(0, 0, 1);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3442, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(0.6, 0.9, 1);
camera.add(key);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = true;
controls.addEventListener('change', render);

const group = new THREE.Group();
scene.add(group);
const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
const surfMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(css('--bone') || '#d8cdb9'), roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide });
const surface = new THREE.Mesh(new THREE.BufferGeometry(), surfMat);
group.add(surface);
const sliceMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false, alphaTest: 0.5 });
const slice = new THREE.Mesh(new THREE.BufferGeometry(), sliceMat);
slice.visible = false;
group.add(slice);

function render() { renderer.render(scene, camera); }
function resize() {
  const box = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width)), h = Math.max(1, Math.round(box.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  render();
}
new ResizeObserver(resize).observe(canvas.parentElement);

// ---------- state ----------
let vol = null, mesh = null, seriesList = [], cutAxis = -1, busy = false, current = null;
const AXIS_NAMES = ['across', 'down', 'through'];

function status(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

function frameCamera() {
  const r = 0.5 * Math.hypot(...vol.dims.map((n, a) => n * vol.spacing[a]));
  const d = r / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  const dir = new THREE.Vector3(0.75, -1.45, 0.55).normalize();
  camera.position.copy(dir.multiplyScalar(d));
  camera.near = d / 100; camera.far = d * 10;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.minDistance = r * 0.2; controls.maxDistance = d * 4;
  controls.update();
}

async function setVolume(v, keep) {
  vol = v;
  group.matrixAutoUpdate = false;
  group.matrix.identity();
  if (v.orient) {
    const [r, c, n] = v.orient.map((a) => new THREE.Vector3(...a).normalize());
    group.matrix.makeBasis(r, c, n);
  }
  group.updateMatrixWorld(true);
  const mm = v.dims.map((n, a) => Math.round(n * v.spacing[a]));
  $('info').textContent = `${v.dims.join(' × ')} voxels · ${v.spacing.map((s) => +s.toFixed(2)).join(' × ')} mm each · ${mm.join(' × ')} mm overall`;
  $('scanName').textContent = v.label;
  if (!keep) { $('thr').value = otsu(v.data); $('thrVal').textContent = $('thr').value; }
  frameCamera();
  setCut(cutAxis, true);
  await rebuild();
}

async function rebuild() {
  if (!vol || busy) return;
  busy = true;
  status('Building the surface…');
  await paint();
  try {
    const q = +document.querySelector('input[name=detail]:checked').value;
    const t0 = performance.now();
    mesh = buildSurface(vol, +$('thr').value, q, $('smooth').checked);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    surface.geometry.dispose();
    surface.geometry = g;
    const tris = mesh.indices.length / 3;
    $('tris').textContent = tris.toLocaleString('en') + ' triangles';
    $('exportBtn').disabled = tris === 0;
    status(tris ? `Surface ready in ${((performance.now() - t0) / 1000).toFixed(1)} s. Drag to rotate, pinch or scroll to zoom.` : 'Nothing is brighter than this level. Lower the surface level.', !tris);
  } catch (e) {
    status('Could not build the surface: ' + e.message, true);
  }
  busy = false;
  updateCut();
  render();
}

// ---------- cut plane ----------
function cutAxes(a) { return a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1]; }

function setCut(axis, keepPos) {
  cutAxis = axis;
  const on = axis >= 0 && vol;
  $('cutRow').hidden = !on;
  slice.visible = !!on;
  surfMat.clippingPlanes = on ? [clip] : [];
  surfMat.needsUpdate = true;
  if (!on) { render(); return; }
  const n = vol.dims[axis], [u, w] = cutAxes(axis);
  const range = $('cutPos');
  range.max = n - 1;
  if (!keepPos || +range.value > n - 1) range.value = Math.floor(n / 2);
  const hu = (vol.dims[u] * vol.spacing[u]) / 2, hw = (vol.dims[w] * vol.spacing[w]) / 2;
  const corners = [[-hu, -hw], [hu, -hw], [hu, hw], [-hu, hw]].map(([cu, cw]) => { const p = [0, 0, 0]; p[u] = cu; p[w] = cw; return p; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(corners.flat()), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  slice.geometry.dispose();
  slice.geometry = g;
  if (sliceMat.map) sliceMat.map.dispose();
  const tex = new THREE.DataTexture(new Uint8Array(vol.dims[u] * vol.dims[w] * 4), vol.dims[u], vol.dims[w], THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  sliceMat.map = tex; sliceMat.needsUpdate = true;
  updateCut();
}

function updateCut() {
  if (cutAxis < 0 || !vol) return;
  const a = cutAxis, [u, w] = cutAxes(a), s = +$('cutPos').value;
  const [nx, ny] = vol.dims, strides = [1, nx, nx * ny];
  const tex = sliceMat.map, px = tex.image.data, d = vol.data, W = vol.dims[u], H = vol.dims[w];
  const air = Math.max(6, +$('thr').value * 0.4);
  let o = 0;
  for (let j = 0; j < H; j++) {
    let i = s * strides[a] + j * strides[w];
    for (let k = 0; k < W; k++, i += strides[u]) { const v = d[i]; px[o++] = v; px[o++] = v; px[o++] = v; px[o++] = v >= air ? 255 : 0; }
  }
  tex.needsUpdate = true;
  const pos = (s - (vol.dims[a] - 1) / 2) * vol.spacing[a];
  slice.position.set(0, 0, 0); slice.position.setComponent(a, pos);
  const flip = $('flip').checked ? 1 : -1;
  const nrm = new THREE.Vector3(); nrm.setComponent(a, flip);
  clip.set(nrm, -flip * pos + 0.01);
  clip.applyMatrix4(group.matrixWorld);
  $('cutVal').textContent = `${s + 1} / ${vol.dims[a]}`;
  render();
}

// ---------- loading ----------
function showImageParams(s) {
  $('imgRow').hidden = !s || !s.isImages;
  if (!s || !s.isImages) return;
  $('pxIn').value = s.params.pixel;
  $('gapIn').value = s.params.gap;
  $('imgHint').textContent = s.params.fromInfo
    ? 'Sizes come from the scan-info.txt file. Change them if you know better values.'
    : 'Images carry no size information. Enter the real pixel size and gap, or the shape will be stretched.';
}

function applyImageParams() {
  if (!current || !current.isImages || !vol || !vol.pxScale) return;
  const px = +$('pxIn').value, gap = +$('gapIn').value;
  if (!(px > 0) || !(gap > 0)) { status('Pixel size and gap must be numbers above 0.', true); return; }
  current.params.pixel = px; current.params.gap = gap;
  vol.spacing = [px * vol.pxScale[0], px * vol.pxScale[1], gap];
  setVolume(vol, true);
}

async function loadSeries(i) {
  const s = seriesList[i];
  if (!s) return;
  current = s;
  showImageParams(s);
  try {
    status('Reading the image stack…');
    await paint();
    const v = await s.build((p) => status(`Reading the image stack… ${Math.round(p * 100)}%`));
    if (v.dims[2] < 3) status('This series has fewer than 3 slices, so the 3D shape will be flat.', true);
    await setVolume(v);
  } catch (e) {
    status('Could not read this series: ' + e.message, true);
  }
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  try {
    status(`Opening ${files.length} file${files.length > 1 ? 's' : ''}…`);
    await paint();
    const bufs = [];
    for (const f of files) bufs.push({ name: f.name, buffer: await f.arrayBuffer() });
    const { series, skipped } = await readFiles(bufs, (p) => status(`Checking files… ${Math.round(p * 100)}%`), decoder);
    if (!series.length) {
      status('No scan images found. Choose DICOM files, a .nii file, or at least 2 JPG/PNG slices named like axial_0001.jpg. A .zip of any of these also works.', true);
      return;
    }
    seriesList = series;
    const sel = $('seriesSel');
    sel.innerHTML = '';
    series.forEach((s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = s.label; sel.appendChild(o); });
    $('seriesRow').hidden = series.length < 2;
    $('seriesHint').textContent = (series.length > 1 ? `${series.length} series found. The one with the most slices is shown first.` : '') + (skipped ? ` ${skipped} other file${skipped > 1 ? 's were' : ' was'} ignored.` : '');
    await loadSeries(0);
  } catch (e) {
    status('Could not open these files: ' + e.message, true);
  }
}

async function entryFiles(entry, out) {
  if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
  else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await entryFiles(e, out);
    }
  }
}

// ---------- image decoding (JPG/PNG slices) ----------
const decoder = {
  async size(buffer) {
    const bmp = await createImageBitmap(new Blob([buffer]));
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  },
  async decode(buffer, w, h) {
    const bmp = await createImageBitmap(new Blob([buffer]));
    const c = this.canvas || (this.canvas = document.createElement('canvas'));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.ctx = null; }
    const ctx = this.ctx || (this.ctx = c.getContext('2d', { willReadFrequently: true }));
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return ctx.getImageData(0, 0, w, h).data;
  },
};

// ---------- export ----------
let downloads = null;
const hosted = typeof window.claude === 'object' && window.claude && typeof window.claude.use === 'function';
if (hosted) window.claude.use('downloads').then((d) => { downloads = d; if (!d) { $('exportBtn').hidden = true; $('exportNote').textContent = 'Saving files is not available in this view.'; } });

async function exportModel() {
  if (!mesh || !mesh.indices.length) return;
  const btn = $('exportBtn');
  btn.disabled = true;
  status('Preparing the model file…');
  await paint();
  try {
    const stl = new Uint8Array(toSTL(mesh.positions, mesh.indices));
    if (hosted) {
      if (!downloads) throw { code: 'unavailable' };
      const zip = zipSync({ 'mri-model.stl': stl }, { level: 1 });
      await downloads.save({ filename: 'mri-model.zip', data: new Blob([zip]) });
      status('Saved mri-model.zip. Unzip it to get the STL file (units are millimetres).');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([stl], { type: 'model/stl' }));
      a.download = 'mri-model.stl';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status('Saved mri-model.stl (units are millimetres).');
    }
  } catch (e) {
    const code = e && e.code;
    if (code === 'declined') status('Save cancelled.');
    else if (code === 'rate_limited') status('A save prompt is already open. Answer it, then try again.', true);
    else if (code === 'too_large') status('The model file is too large to save here. Pick a lower detail level and try again.', true);
    else status('Could not save the model in this view.', true);
  }
  btn.disabled = false;
}

// ---------- wiring ----------
$('fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); });
$('folderInput').addEventListener('change', (e) => { handleFiles(e.target.files); });
$('sampleBtn').addEventListener('click', () => { seriesList = []; current = null; showImageParams(null); $('seriesRow').hidden = true; $('seriesHint').textContent = ''; setVolume(samplePhantom()); });
$('seriesSel').addEventListener('change', (e) => loadSeries(+e.target.value));
$('pxIn').addEventListener('change', applyImageParams);
$('gapIn').addEventListener('change', applyImageParams);
$('thr').addEventListener('input', () => { $('thrVal').textContent = $('thr').value; });
$('thr').addEventListener('change', rebuild);
$('autoBtn').addEventListener('click', () => { if (!vol) return; $('thr').value = otsu(vol.data); $('thrVal').textContent = $('thr').value; rebuild(); });
document.querySelectorAll('input[name=detail]').forEach((r) => r.addEventListener('change', rebuild));
$('smooth').addEventListener('change', rebuild);
document.querySelectorAll('input[name=cut]').forEach((r) => r.addEventListener('change', () => setCut(+r.value, false)));
$('cutPos').addEventListener('input', updateCut);
$('flip').addEventListener('change', updateCut);
$('exportBtn').addEventListener('click', exportModel);
$('resetBtn').addEventListener('click', () => { if (vol) { frameCamera(); render(); } });

const stage = $('stage');
['dragenter', 'dragover'].forEach((t) => stage.addEventListener(t, (e) => { e.preventDefault(); stage.classList.add('drop'); }));
['dragleave', 'drop'].forEach((t) => stage.addEventListener(t, (e) => { e.preventDefault(); stage.classList.remove('drop'); }));
stage.addEventListener('drop', async (e) => {
  const items = [...(e.dataTransfer.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (items.length) { const out = []; for (const en of items) await entryFiles(en, out); handleFiles(out); }
  else handleFiles(e.dataTransfer.files);
});

if (!('webkitdirectory' in document.createElement('input')) || matchMedia('(pointer: coarse)').matches) $('folderLabel').hidden = true;

resize();
setVolume(samplePhantom());
window.__mri = { handleFiles, AXIS_NAMES };

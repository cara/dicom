// Steuerung der Oberfläche: Laden, Serienliste, Anzeige, Wiedergabe, Export.
import { applyIcons, icon } from './ui/icons.js';
import { filesFromDirectoryHandle, filesFromFileList, filesFromDataTransfer, indexFiles, buildStacks } from './viewer/loader.js';
import { Viewport } from './viewer/viewport.js';
import { defaultWindow, autoWindow, frameToCanvas } from './viewer/render.js';
import { exportStackVideo, supportsMp4, supportsWebm, outputSize } from './video/export.js';
import { openOutput, videoFileName, uniqueNamer, download, canPickDirectory } from './video/batch.js';
import { listElements } from './ui/tags.js';
import { createDemoFiles } from './demo.js';
import { decodeVideoDicom, videoStreamExtension } from './dicom/video-dicom.js';
import { getVideoStream } from './dicom/frames.js';
import { transferSyntaxName } from './dicom/parse.js';

const DEFAULT_FPS = 15;
const MEMORY_BUDGET = 1.2e9; // Bytes für dekodierte Frames des aktuellen Stacks

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

const state = {
  stacks: [],
  tree: [],
  current: null,
  frameIndex: 0,
  display: null, // { wc, ww, invert }
  presetLabel: 'dicom-0',
  fps: DEFAULT_FPS,
  playing: false,
  direction: 1,
  loopMode: 'loop',
  anonymize: false,
  sourceDir: null,
  loadId: 0,
  stackToken: 0,
  frameToken: 0,
  maxCached: Infinity,
};

let viewport;
let rafId = 0;
let lastTick = 0;
let acc = 0;

// ---------- Hilfsfunktionen ----------

const yieldToMain = () => new Promise((r) => setTimeout(r, 0));

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatDate(da) {
  if (!da || da.length < 8) return da || '';
  return `${da.slice(6, 8)}.${da.slice(4, 6)}.${da.slice(0, 4)}`;
}

function formatTime(tm) {
  if (!tm || tm.length < 4) return '';
  return `${tm.slice(0, 2)}:${tm.slice(2, 4)}`;
}

function fmtNum(v, digits = 0) {
  return Number.isFinite(v) ? v.toLocaleString('de-DE', { maximumFractionDigits: digits }) : '–';
}

let toastTimer = 0;
function toast(msg, isError = false, ms = 4500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setStatus(text, progress) {
  const el = $('#sidebar-status');
  el.innerHTML = escapeHtml(text) + (progress !== undefined ? `<div class="bar"><div style="width:${Math.round(progress * 100)}%"></div></div>` : '');
}

let loadingTimer = 0;
function setLoading(text) {
  clearTimeout(loadingTimer);
  if (!text) { $('#loading').hidden = true; return; }
  $('#loading-text').textContent = text;
  // Kurz verzögert einblenden, damit schnelle Dekodierung nicht flackert
  loadingTimer = setTimeout(() => { $('#loading').hidden = false; }, 150);
}

function showError(message, actions = []) {
  const el = $('#frame-error');
  if (!message) { el.hidden = true; return; }
  el.innerHTML = `<div>${escapeHtml(message)}</div>`;
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = a.label;
    b.onclick = a.run;
    el.appendChild(b);
  }
  el.hidden = false;
}

function patientLabel(info) {
  if (state.anonymize) return 'Patient';
  return info.patientName || info.patientID || 'Unbekannt';
}

function angleText(info) {
  const a = info.positionerPrimaryAngle;
  const b = info.positionerSecondaryAngle;
  if (!Number.isFinite(a) && !Number.isFinite(b)) return '';
  const p = Number.isFinite(a) ? `${a >= 0 ? 'LAO' : 'RAO'} ${fmtNum(Math.abs(a))}°` : '';
  const s = Number.isFinite(b) ? `${b >= 0 ? 'CRAN' : 'CAUD'} ${fmtNum(Math.abs(b))}°` : '';
  return [p, s].filter(Boolean).join(' / ');
}

// ---------- Laden ----------

async function openFolder() {
  if (typeof window.showDirectoryPicker === 'function') {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'dicom-source', mode: 'read' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      $('#input-folder').click();
      return;
    }
    setStatus('Ordner wird gelesen …', 0);
    try {
      const files = await filesFromDirectoryHandle(handle);
      await loadFiles(files, handle);
    } catch (err) {
      toast(`Ordner konnte nicht gelesen werden: ${err.message}`, true);
    }
    return;
  }
  $('#input-folder').click();
}

function releaseAll() {
  stopPlayback();
  for (const s of state.stacks) s.release();
  state.stacks = [];
  state.tree = [];
  state.current = null;
  viewport.clear();
}

async function loadFiles(files, dirHandle = null) {
  if (!files.length) return;
  const loadId = ++state.loadId;
  releaseAll();
  app.classList.add('no-data');
  $('#series-list').innerHTML = '';
  setStatus(`Lese ${files.length} Dateien …`, 0);
  const { entries, skipped } = await indexFiles(files, (d, t) => {
    if (loadId === state.loadId) setStatus(`Lese Dateien … ${d}/${t}`, d / t);
  });
  if (loadId !== state.loadId) return;
  if (!entries.length) {
    setStatus(`Keine DICOM-Bilder gefunden (${files.length} Dateien geprüft)`);
    toast('In der Auswahl wurden keine DICOM-Bilder gefunden.', true);
    return;
  }
  const { stacks, tree } = buildStacks(entries);
  state.stacks = stacks;
  state.tree = tree;
  state.sourceDir = dirHandle;
  app.classList.remove('no-data');
  renderSeriesList();
  const ignored = files.length - entries.length;
  setStatus(`${entries.length} ${entries.length === 1 ? 'Bilddatei' : 'Bilddateien'} · ${stacks.length} ${stacks.length === 1 ? 'Serie' : 'Serien'}${ignored ? ` · ${ignored} übersprungen` : ''}${skipped.length ? ` (${skipped.length} ohne Bilddaten, z. B. DICOMDIR/SR)` : ''}`);
  await selectStack(stacks[0]);
  thumbnailQueue(loadId);
}

async function thumbnailQueue(loadId) {
  for (const s of [...state.stacks]) {
    if (loadId !== state.loadId) return;
    if (s.thumbnail || s.isVideo) continue;
    const idx = Math.floor((s.frameCount - 1) / 2);
    try {
      const frame = await s.getFrame(idx);
      if (loadId !== state.loadId) return;
      s.thumbnail = makeThumbnail(frame, s.infoFor(idx));
      updateThumb(s);
    } catch (err) {
      s.error = err.message || String(err);
      updateThumb(s);
    }
    if (s !== state.current) s.release();
    await yieldToMain();
  }
}

const thumbCanvas = document.createElement('canvas');
function makeThumbnail(frame, info) {
  const src = frameToCanvas(frame, info, { ...defaultWindow(info, frame), invert: false }, document.createElement('canvas'));
  const size = 128;
  const k = Math.min(size / frame.width, size / frame.height);
  thumbCanvas.width = Math.max(1, Math.round(frame.width * k));
  thumbCanvas.height = Math.max(1, Math.round(frame.height * k));
  const ctx = thumbCanvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, thumbCanvas.width, thumbCanvas.height);
  return thumbCanvas.toDataURL('image/jpeg', 0.75);
}

// ---------- Serienliste ----------

function stackSubline(s) {
  const parts = [];
  parts.push(s.isVideo && !s.videoDecoded ? 'Video' : `${s.frameCount} ${s.frameCount === 1 ? 'Bild' : 'Bilder'}`);
  if (s.frameCount > 1 && s.fps) parts.push(`${fmtNum(s.fps, 1)} fps`);
  if (s.info.modality) parts.push(s.info.modality);
  if (Number.isFinite(s.info.seriesNumber)) parts.push(`Serie ${s.info.seriesNumber}`);
  return parts.join(' · ');
}

function renderSeriesList() {
  const list = $('#series-list');
  list.innerHTML = '';
  for (const p of state.tree) {
    const pd = document.createElement('div');
    pd.className = 'patient';
    const first = p.studies[0]?.stacks[0]?.info || {};
    const name = state.anonymize ? 'Patient' : (p.name || p.id || 'Unbekannt');
    const extra = state.anonymize ? '' : [p.id, formatDate(p.birthDate)].filter(Boolean).join(' · ');
    pd.innerHTML = `<div class="patient-head">${escapeHtml(name)}${extra ? `<small>${escapeHtml(extra)}</small>` : ''}</div>`;
    for (const st of p.studies) {
      const sh = document.createElement('div');
      sh.className = 'study-head';
      sh.textContent = [formatDate(st.date), formatTime(st.time), st.description].filter(Boolean).join(' · ') || first.modality || 'Studie';
      pd.appendChild(sh);
      for (const s of st.stacks) {
        const b = document.createElement('button');
        b.className = 'series';
        b.dataset.id = s.id;
        b.title = s.entries.length === 1 ? s.entries[0].path : `${s.entries.length} Dateien`;
        const badge = s.isVideo ? 'Video' : s.frameCount > 1 ? (s.isMultiFrame ? `▶ ${s.frameCount}` : String(s.frameCount)) : '';
        b.innerHTML = `<div class="thumb">${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ''}</div>
          <div class="series-text"><div class="series-title">${escapeHtml(s.label)}</div><div class="series-sub">${escapeHtml(stackSubline(s))}</div></div>`;
        b.onclick = () => {
          selectStack(s);
          app.classList.remove('sidebar-open');
        };
        pd.appendChild(b);
        updateThumb(s, b);
      }
    }
    list.appendChild(pd);
  }
  highlightCurrent();
}

function updateThumb(s, el = document.querySelector(`.series[data-id="${s.id}"]`)) {
  if (!el) return;
  const t = el.querySelector('.thumb');
  if (s.thumbnail) t.style.backgroundImage = `url("${s.thumbnail}")`;
  if (s.error) {
    el.querySelector('.series-sub').innerHTML = `<span class="series-error">${escapeHtml(s.error)}</span>`;
  }
}

function highlightCurrent() {
  for (const el of document.querySelectorAll('.series')) {
    const active = state.current && Number(el.dataset.id) === state.current.id;
    el.classList.toggle('active', active);
    if (active) el.scrollIntoView({ block: 'nearest' });
  }
}

// ---------- Anzeige ----------

async function selectStack(stack) {
  if (!stack || state.current === stack) return;
  stopPlayback();
  const prev = state.current;
  state.current = stack;
  const token = ++state.stackToken;
  state.frameIndex = 0;
  state.display = null;
  state.presetLabel = 'dicom-0';
  state.maxCached = Infinity;
  state.direction = 1;
  if (prev) prev.release();
  highlightCurrent();
  showError(null);
  viewport.clear();
  viewport.resetView();
  state.fps = stack.fps || DEFAULT_FPS;
  $('#fps-input').value = fmtNum(state.fps, 2).replace(',', '.');
  $('#fps-input').title = stack.fps ? `Bildrate aus DICOM: ${fmtNum(stack.fps, 2)} fps` : 'Keine Bildrate in den DICOM-Daten – Standardwert';

  if (stack.isVideo && !stack.videoDecoded) {
    const ok = await prepareVideo(stack, token);
    if (!ok || token !== state.stackToken) return;
  }
  updateSliderRange();
  await showFrame(0);
  if (token !== state.stackToken) return;
  buildPresetOptions();
  if (!$('#tags-panel').hidden) renderTags();
  prefetch(stack, token, 0);
  if (stack.frameCount > 1 && (stack.isMultiFrame || stack.isVideo)) play();
}

async function prepareVideo(stack, token) {
  const entry = stack.entries[0];
  setLoading('Video wird dekodiert …');
  try {
    const ds = await entry.load();
    const { frames } = await decodeVideoDicom(ds, entry.info, (p) => {
      if (token === state.stackToken) $('#loading-text').textContent = `Video wird dekodiert … ${Math.round(p * 100)} %`;
    });
    if (!frames.length) throw new Error('Keine Bilder im Videostrom');
    stack.frames = frames.map((_, k) => ({ entry, index: k }));
    stack.decoded = frames;
    stack.cache = new Map(frames.map((f, k) => [k, Promise.resolve(f)]));
    stack.videoDecoded = true;
    if (!stack.thumbnail) {
      const mid = Math.floor(frames.length / 2);
      stack.thumbnail = makeThumbnail(frames[mid], stack.infoFor(mid));
    }
    setLoading(null);
    renderSeriesList();
    return true;
  } catch (err) {
    setLoading(null);
    if (token !== state.stackToken) return false;
    showError(`${transferSyntaxName(entry.info.transferSyntax)}: ${err.message || err}`, [
      { label: 'Videostream extrahieren', run: () => extractVideoStream(stack) },
    ]);
    return false;
  }
}

async function extractVideoStream(stack) {
  try {
    const entry = stack.entries[0];
    const ds = await entry.load();
    const bytes = getVideoStream(ds);
    const isMp4 = bytes.length > 8 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp';
    const ext = isMp4 ? 'mp4' : videoStreamExtension(entry.info.transferSyntax);
    download(new Blob([bytes], { type: isMp4 ? 'video/mp4' : 'application/octet-stream' }), `${videoFileName(stack, 'anon', 1)}.${ext}`);
  } catch (err) {
    toast(`Extraktion fehlgeschlagen: ${err.message}`, true);
  }
}

function updateSliderRange() {
  const n = state.current ? state.current.frameCount : 1;
  const slider = $('#frame-slider');
  slider.max = String(Math.max(0, n - 1));
  slider.disabled = n < 2;
  for (const id of ['#btn-play', '#btn-first', '#btn-last', '#btn-prev', '#btn-next']) $(id).disabled = n < 2;
}

function updateFrameUi() {
  const s = state.current;
  if (!s) return;
  $('#frame-slider').value = String(state.frameIndex);
  $('#frame-label').textContent = `${state.frameIndex + 1} / ${s.frameCount}`;
}

/** Zeigt Frame i an; dekodiert bei Bedarf. */
async function showFrame(i) {
  const stack = state.current;
  if (!stack) return;
  const n = stack.frameCount;
  i = Math.max(0, Math.min(n - 1, i));
  state.frameIndex = i;
  updateFrameUi();
  let frame = stack.decoded[i];
  if (!frame) {
    const token = ++state.frameToken;
    setLoading('Dekodiere …');
    try {
      frame = await stack.getFrame(i);
    } catch (err) {
      if (token === state.frameToken && stack === state.current) {
        setLoading(null);
        stopPlayback();
        viewport.clear();
        showError(`Bild ${i + 1} kann nicht angezeigt werden: ${err.message || err}`);
        updateOverlay();
      }
      return;
    }
    if (token !== state.frameToken || stack !== state.current) return;
    setLoading(null);
  }
  showError(null);
  render(frame);
  if (state.maxCached === Infinity) {
    const bytes = frame.data.byteLength || frame.data.length;
    state.maxCached = Math.max(8, Math.floor(MEMORY_BUDGET / Math.max(1, bytes)));
  }
  if (stack.frameCount > state.maxCached) {
    stack.trim(i, state.maxCached);
    schedulePrefetch(i);
  }
}

function render(frame) {
  const stack = state.current;
  const info = stack.infoFor(state.frameIndex);
  if (!state.display) state.display = { ...defaultWindow(info, frame), invert: false };
  viewport.show(frame, info, state.display);
  updateOverlay();
  if (!$('#tags-panel').hidden && !state.playing) renderTagsIfEntryChanged();
}

function rerender() {
  const s = state.current;
  const frame = s && s.decoded[state.frameIndex];
  if (frame) render(frame);
}

let prefetchTimer = 0;
function schedulePrefetch(center) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => prefetch(state.current, state.stackToken, center), 120);
}

/** Dekodiert Frames im Hintergrund (ab `center`, vorwärts), im Rahmen des Speicherbudgets. */
async function prefetch(stack, token, center) {
  if (!stack) return;
  const n = stack.frameCount;
  const myRun = (prefetch.run = (prefetch.run || 0) + 1);
  const limit = Math.min(n, state.maxCached === Infinity ? n : state.maxCached);
  let done = 0;
  for (let k = 0; k < limit; k++) {
    if (token !== state.stackToken || myRun !== prefetch.run) return;
    const i = (center + k) % n;
    if (!stack.decoded[i]) {
      try {
        await stack.getFrame(i);
      } catch {
        // Fehler wird beim Anzeigen gemeldet
      }
      if (k % 3 === 0) await yieldToMain();
    }
    done++;
    if (done % 4 === 0 || done === limit) updateBuffer(stack);
  }
  updateBuffer(stack);
}

function updateBuffer(stack) {
  if (stack !== state.current) return;
  const n = stack.frameCount;
  let c = 0;
  for (let i = 0; i < n; i++) if (stack.decoded[i]) c++;
  $('#buffer-bar > div').style.width = `${(c / n) * 100}%`;
}

function updateOverlay() {
  const s = state.current;
  if (!s) {
    for (const id of ['#ov-tl', '#ov-tr', '#ov-bl', '#ov-br']) $(id).textContent = '';
    return;
  }
  const info = s.infoFor(state.frameIndex);
  const tl = [patientLabel(info)];
  if (!state.anonymize) {
    if (info.patientID) tl.push(`ID ${info.patientID}`);
    if (info.patientBirthDate) tl.push(`*${formatDate(info.patientBirthDate)}`);
  }
  const tr = [info.institution, [formatDate(info.studyDate), formatTime(info.acquisitionTime || info.studyTime)].filter(Boolean).join(' '), info.studyDescription, s.label]
    .filter(Boolean);
  const d = state.display;
  const bl = [`Bild ${state.frameIndex + 1}/${s.frameCount}${s.frameCount > 1 ? ` · ${fmtNum(state.fps, 1)} fps` : ''}`];
  if (d) bl.push(`W ${fmtNum(d.ww, d.ww < 10 ? 2 : 0)}  L ${fmtNum(d.wc, d.ww < 10 ? 2 : 0)}${d.invert ? '  inv.' : ''}`);
  bl.push(`Zoom ${Math.round(viewport.fitScale() * viewport.zoom * 100 / (window.devicePixelRatio || 1))} %`);
  const br = [[info.modality, info.manufacturer].filter(Boolean).join(' · '), `${info.columns}×${info.rows}`, transferSyntaxName(info.transferSyntax)];
  const angles = angleText(info);
  if (angles) br.unshift(angles);
  if (Number.isFinite(info.heartRate) && info.heartRate > 0) br.push(`HF ${fmtNum(info.heartRate)}/min`);
  $('#ov-tl').textContent = tl.join('\n');
  $('#ov-tr').textContent = tr.join('\n');
  $('#ov-bl').textContent = bl.join('\n');
  $('#ov-br').textContent = br.join('\n');
}

// ---------- Fensterung ----------

const CT_PRESETS = [
  ['Weichteil', 40, 400], ['Lunge', -600, 1500], ['Knochen', 400, 1800], ['Gehirn', 40, 80],
  ['Mediastinum', 50, 350], ['Leber', 60, 160], ['Angio (CTA)', 300, 600], ['Herz (Kalk)', 130, 900],
];

function buildPresetOptions() {
  const sel = $('#sel-preset');
  const s = state.current;
  if (!s) return;
  const info = s.infoFor(state.frameIndex);
  const frame = s.decoded[state.frameIndex];
  const opts = [];
  if (frame && frame.color) {
    opts.push(['dicom-0', 'Original']);
  } else {
    info.windowCenter.forEach((c, k) => {
      const w = info.windowWidth[k];
      if (w > 0) opts.push([`dicom-${k}`, `DICOM ${info.windowCenter.length > 1 ? k + 1 : ''} (${fmtNum(c)}/${fmtNum(w)})`.replace('  ', ' ')]);
    });
    if (!opts.length) opts.push(['dicom-0', 'Standard']);
    opts.push(['auto', 'Auto (Min–Max)']);
    if (info.modality === 'CT') for (const [name, c, w] of CT_PRESETS) opts.push([`ct:${c}:${w}`, `${name} (${c}/${w})`]);
  }
  opts.push(['custom', 'Benutzerdefiniert']);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
  sel.value = state.presetLabel;
  if (sel.value !== state.presetLabel) sel.value = opts[0][0];
}

function applyPreset(value) {
  const s = state.current;
  if (!s || !state.display) return;
  const info = s.infoFor(state.frameIndex);
  const frame = s.decoded[state.frameIndex];
  const invert = state.display.invert;
  if (value.startsWith('dicom-')) {
    const k = Number(value.slice(6));
    if (info.windowWidth[k] > 0 && !(frame && frame.color)) state.display = { wc: info.windowCenter[k], ww: info.windowWidth[k], invert };
    else state.display = { ...defaultWindow(info, frame), invert };
  } else if (value === 'auto') {
    state.display = { ...autoWindow(info, frame), invert };
  } else if (value.startsWith('ct:')) {
    const [, c, w] = value.split(':').map(Number);
    state.display = { wc: c, ww: w, invert };
  } else {
    return;
  }
  state.presetLabel = value;
  $('#sel-preset').value = value;
  rerender();
}

let wlFrame = 0;
function onWindowDrag(dx, dy) {
  const d = state.display;
  if (!d) return;
  const k = Math.max(d.ww, 2) / 300;
  d.ww = Math.max(d.ww < 2 ? 0.01 : 1, d.ww + dx * k);
  d.wc += dy * k;
  if (state.presetLabel !== 'custom') {
    state.presetLabel = 'custom';
    $('#sel-preset').value = 'custom';
  }
  if (!wlFrame) {
    wlFrame = requestAnimationFrame(() => {
      wlFrame = 0;
      rerender();
    });
  }
}

function toggleInvert() {
  if (!state.display) return;
  state.display.invert = !state.display.invert;
  $('#btn-invert').setAttribute('aria-pressed', String(state.display.invert));
  rerender();
}

function resetAll() {
  viewport.resetView();
  if (state.current && state.display) {
    state.display.invert = false;
    $('#btn-invert').setAttribute('aria-pressed', 'false');
    applyPreset('dicom-0');
  }
}

// ---------- Wiedergabe ----------

function setPlayButton() {
  const b = $('#btn-play');
  b.innerHTML = icon(state.playing ? 'pause' : 'play', 20);
  b.setAttribute('aria-label', state.playing ? 'Pause' : 'Wiedergabe');
}

function play() {
  const s = state.current;
  if (!s || s.frameCount < 2 || state.playing) return;
  if (state.loopMode === 'once' && state.frameIndex >= s.frameCount - 1) state.frameIndex = 0;
  state.playing = true;
  lastTick = performance.now();
  acc = 0;
  setPlayButton();
  rafId = requestAnimationFrame(tick);
}

function stopPlayback() {
  state.playing = false;
  cancelAnimationFrame(rafId);
  setPlayButton();
}

function togglePlay() {
  if (state.playing) stopPlayback();
  else play();
}

function nextIndex() {
  const n = state.current.frameCount;
  let i = state.frameIndex + state.direction;
  if (state.loopMode === 'loop') return (i + n) % n;
  if (state.loopMode === 'once') return i >= n ? -1 : i;
  if (i >= n || i < 0) {
    state.direction = -state.direction;
    i = state.frameIndex + state.direction;
  }
  return Math.max(0, Math.min(n - 1, i));
}

function tick(now) {
  if (!state.playing) return;
  const s = state.current;
  const dt = now - lastTick;
  lastTick = now;
  const dur = 1000 / state.fps;
  acc += dt;
  if (acc >= dur) {
    const next = nextIndex();
    if (next < 0) {
      stopPlayback();
      return;
    }
    const frame = s.decoded[next];
    if (frame) {
      acc -= dur;
      if (acc > dur * 2) acc = 0; // nach Hängern nicht hinterherhetzen
      state.frameIndex = next;
      render(frame);
      updateFrameUi();
      if (s.frameCount > state.maxCached) {
        s.trim(next, state.maxCached);
        schedulePrefetch(next);
      }
    } else {
      // Auf Dekodierung warten
      acc = dur;
      s.getFrame(next).catch(() => stopPlayback());
    }
  }
  rafId = requestAnimationFrame(tick);
}

function step(delta) {
  if (!state.current) return;
  stopPlayback();
  showFrame(state.frameIndex + delta);
}

function setFps(v) {
  const fps = Math.max(1, Math.min(120, Math.round(v * 100) / 100));
  if (!Number.isFinite(fps)) return;
  state.fps = fps;
  $('#fps-input').value = String(fps);
  updateOverlay();
}

// ---------- Tags ----------

let tagsEntryId = 0;
async function renderTags() {
  const s = state.current;
  if (!s) return;
  const entry = s.frames[state.frameIndex].entry;
  tagsEntryId = entry.id;
  $('#tags-file').textContent = entry.path;
  try {
    const ds = entry.ds || (await entry.load());
    if (tagsEntryId !== entry.id) return;
    const rows = listElements(ds, { hidePatient: state.anonymize });
    // Einzelbild-Dateien nach dem Lesen wieder freigeben (Frames sind separat dekodiert)
    if (entry.info.numberOfFrames === 1 && s.decoded[state.frameIndex]) entry.unload();
    const html = rows.slice(0, 5000).map((r) => {
      const pad = r.depth ? ` style="padding-left:${6 + r.depth * 10}px"` : '';
      return `<tr class="${r.tag ? '' : 'item'}"><td class="t"${pad}>${r.tag}</td><td class="vr">${r.vr}</td><td class="n">${escapeHtml(r.name)}</td><td class="v">${escapeHtml(r.value)}</td></tr>`;
    }).join('');
    $('#tags-table tbody').innerHTML = html;
    filterTags();
  } catch (err) {
    $('#tags-table tbody').innerHTML = `<tr><td>${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderTagsIfEntryChanged() {
  const s = state.current;
  if (s && s.frames[state.frameIndex].entry.id !== tagsEntryId) renderTags();
}

function filterTags() {
  const q = $('#tags-filter').value.trim().toLowerCase();
  for (const tr of $('#tags-table tbody').rows) {
    tr.hidden = q && !tr.textContent.toLowerCase().includes(q);
  }
}

function toggleTags(force) {
  const panel = $('#tags-panel');
  const show = force ?? panel.hidden;
  panel.hidden = !show;
  $('#btn-tags').setAttribute('aria-pressed', String(show));
  if (show) renderTags();
  requestAnimationFrame(() => viewport.resize());
}

// ---------- Export ----------

function overlayLinesFor(stack, mode) {
  if (mode === 'none') return undefined;
  const i = stack.info;
  const head = [];
  if (mode === 'patient' && i.patientName) head.push(i.patientName);
  head.push([stack.label, formatDate(i.studyDate)].filter(Boolean).join(' · '));
  const angles = angleText(i);
  if (angles) head.push(angles);
  return (k) => [...head, `Bild ${k + 1}/${stack.frameCount}`];
}

function sizeOptions(w, h) {
  const opts = [['0', `Original (${outputSize(w, h).width}×${outputSize(w, h).height})`]];
  for (const m of [480, 720, 1080]) {
    if (Math.max(w, h) > m) {
      const o = outputSize(w, h, { maxSize: m });
      opts.push([String(m), `max. ${m} px (${o.width}×${o.height})`]);
    }
  }
  if (Math.max(w, h) <= 960) {
    const o = outputSize(w, h, { scale: 2, maxSize: 1920 });
    opts.push(['2x', `2× vergrößert (${o.width}×${o.height})`]);
  }
  return opts;
}

function sizeOptionToParams(v) {
  if (v === '2x') return { scale: 2, maxSize: 1920 };
  return { maxSize: Number(v) || 0 };
}

function setupFormatSelect(sel) {
  const mp4 = sel.querySelector('option[value="mp4"]');
  const webm = sel.querySelector('option[value="webm"]');
  mp4.disabled = !supportsMp4();
  webm.disabled = !supportsWebm();
  sel.value = mp4.disabled ? 'webm' : 'mp4';
}

function openExportDialog() {
  const s = state.current;
  if (!s) return;
  const frame = s.decoded[state.frameIndex];
  if (!frame) { toast('Bild wird noch geladen …'); return; }
  if (!supportsMp4() && !supportsWebm()) { toast('Dieser Browser unterstützt keinen Video-Export. Bitte aktuelles Chrome, Edge, Safari oder Firefox verwenden.', true); return; }
  stopPlayback();
  const dlg = $('#dlg-export');
  const f = dlg.querySelector('form');
  $('#exp-source').textContent = `${s.label} · ${s.frameCount} Bilder · ${frame.width}×${frame.height}`;
  setupFormatSelect(f.format);
  f.fps.value = String(state.fps);
  $('#exp-fps-hint').textContent = s.fps ? `DICOM: ${fmtNum(s.fps, 2)} fps` : 'keine Angabe in DICOM';
  f.from.value = '1';
  f.to.value = String(s.frameCount);
  f.from.max = f.to.max = String(s.frameCount);
  f.size.innerHTML = sizeOptions(frame.width, frame.height).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  f.window.value = 'current';
  f.overlay.value = 'none';
  $('#exp-warning').hidden = s.frameCount > 1;
  $('#exp-warning').textContent = 'Diese Serie enthält nur ein Bild – das Video zeigt ein Standbild.';
  dlg.returnValue = '';
  dlg.showModal();
}

async function runSingleExport() {
  const s = state.current;
  const f = $('#dlg-export form');
  const n = s.frameCount;
  const from = Math.max(1, Math.min(n, Number(f.from.value) || 1)) - 1;
  const to = Math.max(from + 1, Math.min(n, Number(f.to.value) || n)) - 1;
  const first = await s.getFrame(from);
  const display = f.window.value === 'current' ? { ...state.display } : { ...defaultWindow(s.infoFor(from), first), invert: false };
  const ac = new AbortController();
  const prog = progressDialog('Video wird erzeugt', ac);
  prog.text(`${s.label} – ${to - from + 1} Bilder`);
  try {
    const { blob, extension, codec } = await exportStackVideo({
      stack: s,
      display,
      fps: Number(f.fps.value) || state.fps,
      from,
      to: Math.max(from, to),
      repeat: Number(f.repeat.value) || 1,
      bounce: f.bounce.checked,
      quality: f.quality.value,
      format: f.format.value,
      ...sizeOptionToParams(f.size.value),
      overlay: overlayLinesFor(s, f.overlay.value),
      onProgress: (p) => prog.set(p),
      signal: ac.signal,
    });
    const name = `${videoFileName(s, 'anon', state.stacks.indexOf(s) + 1)}.${extension}`;
    download(blob, name);
    prog.close();
    toast(`Gespeichert: ${name} (${(blob.size / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB, ${codec})`);
  } catch (err) {
    prog.close();
    if (err.name !== 'AbortError') toast(`Export fehlgeschlagen: ${err.message || err}`, true, 8000);
  }
}

function progressDialog(title, abortController) {
  const dlg = $('#dlg-progress');
  $('#prog-title').textContent = title;
  $('#prog-text').textContent = '';
  $('#prog-bar').style.width = '0%';
  $('#prog-sub-wrap').hidden = true;
  $('#prog-log').innerHTML = '';
  const cancel = $('#prog-cancel');
  cancel.textContent = 'Abbrechen';
  cancel.onclick = () => abortController.abort();
  dlg.oncancel = (e) => { e.preventDefault(); abortController.abort(); };
  dlg.showModal();
  return {
    text: (t) => { $('#prog-text').textContent = t; },
    set: (p) => { $('#prog-bar').style.width = `${Math.round(p * 100)}%`; },
    sub: (p) => { $('#prog-sub-wrap').hidden = false; $('#prog-sub').style.width = `${Math.round(p * 100)}%`; },
    log: (t, cls) => {
      const d = document.createElement('div');
      d.className = cls || '';
      d.textContent = t;
      $('#prog-log').appendChild(d);
      d.scrollIntoView({ block: 'nearest' });
    },
    done: () => {
      cancel.textContent = 'Schließen';
      cancel.onclick = () => dlg.close();
      dlg.oncancel = null;
    },
    close: () => dlg.close(),
  };
}

function isCine(s) {
  return s.frameCount > 1 && (s.isMultiFrame || s.isVideo);
}

function openBatchDialog() {
  if (!state.stacks.length) return;
  if (!supportsMp4() && !supportsWebm()) { toast('Dieser Browser unterstützt keinen Video-Export.', true); return; }
  stopPlayback();
  const dlg = $('#dlg-batch');
  const f = dlg.querySelector('form');
  setupFormatSelect(f.format);
  const anyCine = state.stacks.some(isCine);
  const list = $('#batch-list');
  list.innerHTML = '';
  for (const s of state.stacks) {
    const row = document.createElement('label');
    row.className = 'batch-item';
    row.innerHTML = `<input type="checkbox" value="${s.id}" ${(anyCine ? isCine(s) : s.frameCount > 1) ? 'checked' : ''}>
      <div class="thumb" style="${s.thumbnail ? `background-image:url('${s.thumbnail}')` : ''}"></div>
      <div>${escapeHtml(s.label)}</div><div class="meta">${escapeHtml(stackSubline(s))}</div>`;
    list.appendChild(row);
  }
  const targets = [];
  if (state.sourceDir && canPickDirectory()) targets.push(['source', `Unterordner „Videos“ in „${state.sourceDir.name}“`]);
  if (canPickDirectory()) targets.push(['pick', 'Ordner wählen …']);
  targets.push(['zip', 'ZIP-Datei herunterladen']);
  targets.push(['downloads', 'Einzelne Downloads']);
  f.target.innerHTML = targets.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
  f.fps.value = String(DEFAULT_FPS);
  f.naming.value = 'anon';
  updateBatchCount();
  dlg.returnValue = '';
  dlg.showModal();
}

function updateBatchCount() {
  const boxes = [...document.querySelectorAll('#batch-list input')];
  const n = boxes.filter((b) => b.checked).length;
  $('#batch-count').textContent = `${n} von ${boxes.length} ausgewählt`;
  $('#batch-all').checked = n === boxes.length;
  $('#batch-all').indeterminate = n > 0 && n < boxes.length;
}

async function runBatchExport() {
  const f = $('#dlg-batch form');
  const ids = new Set([...document.querySelectorAll('#batch-list input:checked')].map((b) => Number(b.value)));
  const selected = state.stacks.filter((s) => ids.has(s.id));
  if (!selected.length) { toast('Keine Serie ausgewählt.'); return; }
  let out;
  try {
    out = await openOutput(f.target.value, state.sourceDir);
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, true);
    return;
  }
  const opts = {
    format: f.format.value,
    fpsMode: f.fpsMode.value,
    fps: Number(f.fps.value) || DEFAULT_FPS,
    repeat: Number(f.repeat.value) || 1,
    quality: f.quality.value,
    size: f.size.value,
    overlay: f.overlay.value,
    naming: f.naming.value,
  };
  const ac = new AbortController();
  const prog = progressDialog(`${selected.length} Videos werden erzeugt`, ac);
  const nameFor = uniqueNamer();
  let ok = 0;
  let failed = 0;
  for (let k = 0; k < selected.length; k++) {
    if (ac.signal.aborted) break;
    const s = selected[k];
    prog.text(`${k + 1}/${selected.length}: ${s.label}`);
    prog.set(k / selected.length);
    prog.sub(0);
    try {
      if (s.isVideo && !s.videoDecoded) {
        const ds = await s.entries[0].load();
        const { frames } = await decodeVideoDicom(ds, s.entries[0].info);
        s.frames = frames.map((_, idx) => ({ entry: s.entries[0], index: idx }));
        s.decoded = frames;
        s.cache = new Map(frames.map((fr, idx) => [idx, Promise.resolve(fr)]));
        s.videoDecoded = true;
      }
      const first = await s.getFrame(0);
      const display = { ...defaultWindow(s.infoFor(0), first), invert: false };
      const sizeParams = opts.size === '2x' ? { scale: 2, maxSize: 1080 } : { maxSize: Number(opts.size) || 0 };
      const { blob, extension } = await exportStackVideo({
        stack: s,
        display,
        fps: opts.fpsMode === 'dicom' ? (s.fps || opts.fps) : opts.fps,
        repeat: opts.repeat,
        quality: opts.quality,
        format: opts.format,
        ...sizeParams,
        overlay: overlayLinesFor(s, opts.overlay),
        onProgress: (p) => { prog.sub(p); prog.set((k + p) / selected.length); },
        signal: ac.signal,
      });
      const name = nameFor(videoFileName(s, opts.naming, state.stacks.indexOf(s) + 1), extension);
      await out.write(name, blob);
      prog.log(`✓ ${name}`, 'ok');
      ok++;
    } catch (err) {
      if (err.name === 'AbortError') break;
      prog.log(`✗ ${s.label}: ${err.message || err}`, 'err');
      failed++;
    }
    if (s !== state.current) s.release();
    await yieldToMain();
  }
  try {
    await out.close();
  } catch (err) {
    prog.log(`✗ Speichern fehlgeschlagen: ${err.message}`, 'err');
  }
  prog.set(1);
  prog.text(ac.signal.aborted ? `Abgebrochen – ${ok} Videos gespeichert.` : `Fertig: ${ok} Videos gespeichert (${out.label})${failed ? `, ${failed} fehlgeschlagen` : ''}.`);
  prog.done();
}

function savePng() {
  const s = state.current;
  const frame = s && s.decoded[state.frameIndex];
  if (!frame) return;
  const c = frameToCanvas(frame, s.infoFor(state.frameIndex), state.display, document.createElement('canvas'));
  c.toBlob((blob) => download(blob, `${videoFileName(s, 'anon', state.stacks.indexOf(s) + 1)}_Bild${state.frameIndex + 1}.png`), 'image/png');
}

// ---------- Sonstiges ----------

function setTool(tool) {
  viewport.tool = tool;
  for (const b of document.querySelectorAll('[data-tool]')) {
    const on = b.dataset.tool === tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
}

function toggleAnonymize() {
  state.anonymize = !state.anonymize;
  $('#btn-anon').setAttribute('aria-pressed', String(state.anonymize));
  renderSeriesList();
  updateOverlay();
  if (!$('#tags-panel').hidden) renderTags();
  toast(state.anonymize ? 'Patientendaten werden ausgeblendet' : 'Patientendaten werden angezeigt', false, 1800);
}

function toggleSidebar() {
  if (window.matchMedia('(max-width: 760px)').matches) app.classList.toggle('sidebar-open');
  else app.classList.toggle('sidebar-collapsed');
  requestAnimationFrame(() => viewport.resize());
}

function toggleFullscreen() {
  const el = $('#stage');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }
}

function selectRelativeStack(delta) {
  const s = state.current;
  if (!s) return;
  const i = state.stacks.indexOf(s) + delta;
  if (i >= 0 && i < state.stacks.length) selectStack(state.stacks[i]);
}

function onKey(e) {
  if (e.key === 'Escape' && !$('#tags-panel').hidden && !e.target.closest('dialog[open]')) {
    toggleTags(false);
    return;
  }
  if (e.target.closest('input, select, textarea, dialog[open]') || e.isComposing) return;
  if (e.metaKey || e.ctrlKey) return;
  const k = e.key;
  const handled = {
    ' ': togglePlay,
    ArrowLeft: () => step(-1),
    ArrowRight: () => step(1),
    PageUp: () => step(-10),
    PageDown: () => step(10),
    ArrowUp: () => selectRelativeStack(-1),
    ArrowDown: () => selectRelativeStack(1),
    Home: () => step(-Infinity),
    End: () => step(Infinity),
    '+': () => setFps(state.fps + 1),
    '=': () => setFps(state.fps + 1),
    '-': () => setFps(state.fps - 1),
    w: () => setTool('wl'),
    p: () => setTool('pan'),
    z: () => setTool('zoom'),
    s: () => setTool('scroll'),
    i: toggleInvert,
    r: resetAll,
    m: () => applyPreset('auto'),
    e: openExportDialog,
    b: openBatchDialog,
    t: () => toggleTags(),
    a: toggleAnonymize,
    f: toggleFullscreen,
    o: openFolder,
    '?': () => $('#dlg-help').showModal(),
    h: () => $('#dlg-help').showModal(),
  }[k.length === 1 ? k.toLowerCase() : k];
  if (handled && (state.current || 'oa?h'.includes(k.toLowerCase()))) {
    e.preventDefault();
    handled();
  }
}

function bindUi() {
  $('#btn-open-folder').onclick = openFolder;
  $('#btn-open-files').onclick = () => $('#input-files').click();
  $('#input-folder').onchange = (e) => { loadFiles(filesFromFileList(e.target.files)); e.target.value = ''; };
  $('#input-files').onchange = (e) => { loadFiles(filesFromFileList(e.target.files)); e.target.value = ''; };
  for (const b of document.querySelectorAll('[data-action]')) {
    b.onclick = () => ({
      'open-folder': openFolder,
      'open-files': () => $('#input-files').click(),
      demo: () => loadFiles(createDemoFiles()),
    })[b.dataset.action]();
  }
  for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('#btn-sidebar').onclick = toggleSidebar;
  $('#btn-invert').onclick = toggleInvert;
  $('#btn-reset').onclick = resetAll;
  $('#sel-preset').onchange = (e) => applyPreset(e.target.value);
  $('#btn-play').onclick = togglePlay;
  $('#btn-first').onclick = () => step(-Infinity);
  $('#btn-last').onclick = () => step(Infinity);
  $('#btn-prev').onclick = () => step(-1);
  $('#btn-next').onclick = () => step(1);
  $('#frame-slider').oninput = (e) => { stopPlayback(); showFrame(Number(e.target.value)); };
  $('#fps-input').onchange = (e) => setFps(Number(e.target.value));
  $('#loop-mode').onchange = (e) => { state.loopMode = e.target.value; state.direction = 1; };
  $('#btn-export').onclick = openExportDialog;
  $('#btn-batch').onclick = openBatchDialog;
  $('#btn-png').onclick = savePng;
  $('#btn-tags').onclick = () => toggleTags();
  $('#btn-tags-close').onclick = () => toggleTags(false);
  $('#tags-filter').oninput = filterTags;
  $('#btn-anon').onclick = toggleAnonymize;
  $('#btn-fullscreen').onclick = toggleFullscreen;
  $('#btn-help').onclick = () => $('#dlg-help').showModal();
  $('#dlg-export').addEventListener('close', () => { if ($('#dlg-export').returnValue === 'ok') runSingleExport(); });
  $('#dlg-batch').addEventListener('close', () => { if ($('#dlg-batch').returnValue === 'ok') runBatchExport(); });
  $('#batch-list').addEventListener('change', updateBatchCount);
  $('#batch-all').onchange = (e) => {
    for (const b of document.querySelectorAll('#batch-list input')) b.checked = e.target.checked;
    updateBatchCount();
  };
  $('#batch-cine').onclick = () => {
    for (const b of document.querySelectorAll('#batch-list input')) b.checked = isCine(state.stacks.find((s) => s.id === Number(b.value)));
    updateBatchCount();
  };
  document.addEventListener('keydown', onKey);

  // Drag & Drop
  let dragDepth = 0;
  const hint = $('#drop-hint');
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    hint.hidden = false;
  });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; hint.hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    hint.hidden = true;
    if (!e.dataTransfer) return;
    setStatus('Lese abgelegte Dateien …', 0);
    try {
      const files = await filesFromDataTransfer(e.dataTransfer);
      await loadFiles(files);
    } catch (err) {
      toast(`Dateien konnten nicht gelesen werden: ${err.message}`, true);
    }
  });

  // Offline-Download nur anbieten, wenn nicht bereits lokal geöffnet
  if (location.protocol === 'file:') $('#btn-download').hidden = true;
  $('#app-version').textContent = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
}

function init() {
  applyIcons();
  viewport = new Viewport($('#viewport'), {
    onWindow: onWindowDrag,
    onScroll: (n) => { if (state.current) step(n); },
    onChange: () => updateOverlay(),
  });
  setPlayButton();
  bindUi();
  setStatus('Kein Ordner geöffnet');
  // Für automatisierte Tests / Konsole
  window.dicomViewer = { state, loadFiles, selectStack, showFrame, play, stopPlayback };
}

init();

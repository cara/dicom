// Einlesen lokaler Dateien/Ordner, Indexierung der DICOM-Header und Gruppierung in Bildstapel (Stacks).
import { parseDicom, extractInfo, isVideoTransferSyntax } from '../dicom/parse.js';
import { decodeFrame } from '../dicom/decode.js';

const HEADER_BYTES = 128 * 1024;
const IGNORED = /(^\.|^thumbs\.db$|\.(txt|xml|html?|pdf|png|jpe?g|gif|bmp|exe|dll|inf|ini|json|js|css|zip|log)$)/i;

/** Rekursiv alle Dateien eines Verzeichnis-Handles (File System Access API) einsammeln. */
export async function filesFromDirectoryHandle(dirHandle, prefix = '') {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') out.push({ file: await handle.getFile(), path });
    else out.push(...(await filesFromDirectoryHandle(handle, path)));
  }
  return out;
}

/** Dateien aus einem <input type=file> (auch webkitdirectory). */
export function filesFromFileList(list) {
  return Array.from(list, (file) => ({ file, path: file.webkitRelativePath || file.name }));
}

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkEntry(entry, prefix, out) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, path });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries liefert in Chrome höchstens 100 Einträge pro Aufruf
    for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
      for (const child of batch) await walkEntry(child, path, out);
    }
  }
}

/** Dateien/Ordner aus einem Drag-&-Drop-Ereignis. */
export async function filesFromDataTransfer(dt) {
  const out = [];
  const entries = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) out.push({ file: f, path: f.name });
    }
  }
  for (const entry of entries) await walkEntry(entry, '', out);
  if (!entries.length && !out.length && dt.files) out.push(...filesFromFileList(dt.files));
  return out;
}

let entryCounter = 0;

/** Eine DICOM-Datei; die vollständigen Bytes werden erst bei Bedarf geladen. */
export class DicomEntry {
  constructor(file, path, info) {
    this.id = ++entryCounter;
    this.file = file;
    this.path = path;
    this.info = info;
    this.ds = null;
    this.loading = null;
  }

  async load() {
    if (this.ds) return this.ds;
    if (!this.loading) {
      this.loading = this.file.arrayBuffer().then((buf) => {
        this.ds = parseDicom(new Uint8Array(buf));
        this.loading = null;
        return this.ds;
      }, (err) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  unload() {
    this.ds = null;
  }
}

async function indexFile({ file, path }) {
  const name = path.split('/').pop();
  if (IGNORED.test(name) || file.size < 132) return null;
  let ds;
  let bytes = new Uint8Array(await file.slice(0, Math.min(file.size, HEADER_BYTES)).arrayBuffer());
  try {
    ds = parseDicom(bytes, { untilPixelData: true });
  } catch (err) {
    if (file.size <= HEADER_BYTES) throw err;
    // Header größer als der gelesene Ausschnitt → komplette Datei
    bytes = new Uint8Array(await file.arrayBuffer());
    ds = parseDicom(bytes, { untilPixelData: true });
  }
  const info = extractInfo(ds);
  if (!info.hasPixelData || !info.rows || !info.columns) return { skipped: path, reason: 'keine Bilddaten' };
  return new DicomEntry(file, path, info);
}

/**
 * Liest die Header aller Dateien.
 * @param {{file: File, path: string}[]} files
 * @param {(done:number, total:number)=>void} [onProgress]
 */
export async function indexFiles(files, onProgress) {
  const entries = [];
  const skipped = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      try {
        const res = await indexFile(f);
        if (res instanceof DicomEntry) entries.push(res);
        else if (res) skipped.push(res);
      } catch {
        // keine DICOM-Datei
      }
      done++;
      if (onProgress && (done % 10 === 0 || done === files.length)) onProgress(done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
  return { entries, skipped };
}

function sortNum(a, b) {
  const x = Number.isFinite(a) ? a : Infinity;
  const y = Number.isFinite(b) ? b : Infinity;
  return x - y;
}

/** Position entlang der Schichtnormalen (für CT/MR-Stapel ohne Instance Number). */
function slicePosition(info) {
  const o = info.imageOrientation;
  const p = info.imagePosition;
  if (o.length !== 6 || p.length !== 3) return NaN;
  const n = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
  return n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
}

let stackCounter = 0;

/** Ein abspielbarer/blätterbarer Bildstapel: Multiframe-Datei oder Serie aus Einzelbildern. */
export class Stack {
  constructor(entries, frames) {
    this.id = ++stackCounter;
    this.entries = entries;
    this.frames = frames; // [{entry, index}]
    this.info = entries[0].info;
    this.cache = new Map();
    this.decoded = []; // synchron verfügbare, fertig dekodierte Frames (für flüssige Wiedergabe)
    this.isVideo = isVideoTransferSyntax(this.info.transferSyntax);
    this.fps = this.info.fps;
    if (!this.fps && entries.length > 1) {
      // Einzelbilder einer Ultraschall-/Angio-Serie: Frame Time evtl. in jedem Bild
      this.fps = entries.find((e) => e.info.fps)?.info.fps || null;
    }
    this.thumbnail = null;
  }

  get frameCount() {
    return this.frames.length;
  }

  get isMultiFrame() {
    return this.entries.length === 1 && this.info.numberOfFrames > 1;
  }

  get label() {
    const i = this.info;
    return i.seriesDescription || i.protocolName || i.studyDescription || i.modality || this.entries[0].path.split('/').pop();
  }

  /** Info-Objekt, das zu einem bestimmten Frame gehört (bei Einzelbildserien je Datei). */
  infoFor(frameIndex) {
    return this.frames[frameIndex].entry.info;
  }

  /** Dekodierten Frame liefern (mit Cache). */
  getFrame(i) {
    let p = this.cache.get(i);
    if (!p) {
      const { entry, index } = this.frames[i];
      p = entry.load().then(async (ds) => {
        const frame = await decodeFrame(ds, entry.info, index);
        // Einzelbild-Dateien: dekodierte Pixel sind kopiert → Dateipuffer sofort freigeben
        if (entry.info.numberOfFrames === 1) entry.unload();
        if (this.cache.get(i) === p) this.decoded[i] = frame;
        return frame;
      });
      p.catch(() => { if (this.cache.get(i) === p) this.cache.delete(i); });
      this.cache.set(i, p);
    }
    return p;
  }

  isCached(i) {
    return this.cache.has(i);
  }

  /** Frames weit entfernt von `center` verwerfen, bis höchstens `max` im Cache sind. */
  trim(center, max) {
    if (this.cache.size <= max) return;
    const keys = [...this.cache.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const k of keys) {
      if (this.cache.size <= max) break;
      this.cache.delete(k);
      this.decoded[k] = undefined;
    }
  }

  /** Speicher freigeben. */
  release() {
    this.cache.clear();
    this.decoded = [];
    for (const e of this.entries) e.unload();
    if (this.isVideo && this.videoDecoded) {
      this.videoDecoded = false;
      this.frames = [{ entry: this.entries[0], index: 0 }];
    }
  }
}

/**
 * Gruppiert Dateien in Stacks und diese in Patienten/Studien.
 * @param {DicomEntry[]} entries
 */
export function buildStacks(entries) {
  const stacks = [];
  const series = new Map();
  const seen = new Set();
  for (const e of entries) {
    // Doppelte Dateien (z. B. gleiche Bilder in mehreren Ordnern einer CD) nur einmal anzeigen
    const uid = e.info.sopInstanceUID;
    if (uid) {
      if (seen.has(uid)) continue;
      seen.add(uid);
    }
    const i = e.info;
    if (i.numberOfFrames > 1 || isVideoTransferSyntax(i.transferSyntax)) {
      const n = isVideoTransferSyntax(i.transferSyntax) ? 1 : i.numberOfFrames;
      stacks.push(new Stack([e], Array.from({ length: n }, (_, k) => ({ entry: e, index: k }))));
      continue;
    }
    const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    const key = [i.seriesInstanceUID || `dir:${dir}`, i.rows, i.columns, i.samplesPerPixel].join('|');
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(e);
  }
  for (const group of series.values()) {
    group.sort((a, b) =>
      sortNum(a.info.instanceNumber, b.info.instanceNumber) ||
      sortNum(slicePosition(a.info), slicePosition(b.info)) ||
      a.path.localeCompare(b.path, undefined, { numeric: true }));
    stacks.push(new Stack(group, group.map((entry) => ({ entry, index: 0 }))));
  }

  // Hierarchie Patient → Studie → Stacks
  const patients = new Map();
  for (const s of stacks) {
    const i = s.info;
    const pKey = `${i.patientID}|${i.patientName}`;
    if (!patients.has(pKey)) patients.set(pKey, { key: pKey, name: i.patientName, id: i.patientID, birthDate: i.patientBirthDate, studies: new Map() });
    const p = patients.get(pKey);
    const sKey = i.studyInstanceUID || `${i.studyDate}|${i.studyDescription}`;
    if (!p.studies.has(sKey)) p.studies.set(sKey, { key: sKey, date: i.studyDate, time: i.studyTime, description: i.studyDescription, stacks: [] });
    p.studies.get(sKey).stacks.push(s);
  }
  const tree = [...patients.values()].map((p) => ({
    ...p,
    studies: [...p.studies.values()]
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .map((st) => ({
        ...st,
        stacks: st.stacks.sort((a, b) =>
          sortNum(a.info.seriesNumber, b.info.seriesNumber) ||
          (a.info.acquisitionTime || '').localeCompare(b.info.acquisitionTime || '') ||
          sortNum(a.info.instanceNumber, b.info.instanceNumber) ||
          a.entries[0].path.localeCompare(b.entries[0].path, undefined, { numeric: true })),
      })),
  }));
  const ordered = tree.flatMap((p) => p.studies.flatMap((st) => st.stacks));
  return { stacks: ordered, tree };
}

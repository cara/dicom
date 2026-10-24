import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDicom } from '../src/dicom/writer.js';
import { parseDicom, extractInfo, deriveFps } from '../src/dicom/parse.js';
import { decodeFrame } from '../src/dicom/decode.js';
import { decodeRLE } from '../src/dicom/rle.js';
import { renderFrame, defaultWindow } from '../src/viewer/render.js';
import { DicomEntry, buildStacks } from '../src/viewer/loader.js';

function baseElements({ rows, cols, frames = 1, bits = 8, signed = 0, spp = 1, photometric = 'MONOCHROME2', extra = [] }) {
  return [
    [0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.12.1'],
    [0x0008, 0x0018, 'UI', '1.2.3.4.5'],
    [0x0008, 0x0060, 'CS', 'XA'],
    [0x0010, 0x0010, 'PN', 'Muster^Max'],
    [0x0020, 0x000d, 'UI', '1.2.3'],
    [0x0020, 0x000e, 'UI', '1.2.3.1'],
    [0x0028, 0x0002, 'US', spp],
    [0x0028, 0x0004, 'CS', photometric],
    [0x0028, 0x0008, 'IS', String(frames)],
    [0x0028, 0x0010, 'US', rows],
    [0x0028, 0x0011, 'US', cols],
    [0x0028, 0x0100, 'US', bits],
    [0x0028, 0x0101, 'US', bits],
    [0x0028, 0x0102, 'US', bits - 1],
    [0x0028, 0x0103, 'US', signed],
    ...extra,
  ];
}

/** PackBits-Encoder für die RLE-Tests. */
function packBits(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let run = 1;
    while (i + run < bytes.length && run < 128 && bytes[i + run] === bytes[i]) run++;
    if (run > 1) {
      out.push(257 - run, bytes[i]);
      i += run;
      continue;
    }
    let lit = 1;
    while (i + lit < bytes.length && lit < 128 && bytes[i + lit] !== bytes[i + lit - 1]) lit++;
    if (i + lit < bytes.length && lit > 1) lit--;
    out.push(lit - 1, ...bytes.subarray(i, i + lit));
    i += lit;
  }
  if (out.length % 2) out.push(128);
  return Uint8Array.from(out);
}

function rleFrame(segments) {
  const header = new DataView(new ArrayBuffer(64));
  header.setUint32(0, segments.length, true);
  let offset = 64;
  const encoded = segments.map(packBits);
  encoded.forEach((s, i) => { header.setUint32(4 + i * 4, offset, true); offset += s.length; });
  const out = new Uint8Array(offset);
  out.set(new Uint8Array(header.buffer), 0);
  let o = 64;
  for (const s of encoded) { out.set(s, o); o += s.length; }
  return out;
}

test('Metadaten und Bildrate werden gelesen', () => {
  const bytes = writeDicom(baseElements({
    rows: 4, cols: 4, frames: 3,
    extra: [[0x0018, 0x1063, 'DS', '33.333'], [0x0028, 0x1050, 'DS', '40\\50'], [0x0028, 0x1051, 'DS', '400\\500']],
  }), { pixelData: new Uint8Array(48) });
  const info = extractInfo(parseDicom(bytes));
  assert.equal(info.rows, 4);
  assert.equal(info.numberOfFrames, 3);
  assert.equal(info.patientName, 'Muster Max');
  assert.equal(info.modality, 'XA');
  assert.equal(info.fps, 30);
  assert.deepEqual(info.windowCenter, [40, 50]);
  assert.equal(info.hasPixelData, true);
});

test('deriveFps nutzt Cine Rate und Frame Time Vector als Rückfall', () => {
  const base = { frameTime: NaN, recommendedFrameRate: NaN, cineRate: NaN, frameTimeVector: [] };
  assert.equal(deriveFps({ ...base, cineRate: 15 }), 15);
  assert.equal(deriveFps({ ...base, frameTimeVector: [0, 40, 40, 40] }), 25);
  assert.equal(deriveFps(base), null);
});

test('Header-Parsing bis zu den Pixeldaten', () => {
  const bytes = writeDicom(baseElements({ rows: 2, cols: 2 }), { pixelData: new Uint8Array(4) });
  const info = extractInfo(parseDicom(bytes, { untilPixelData: true }));
  assert.equal(info.hasPixelData, true);
});

test('unkomprimiert 8 Bit Multiframe', async () => {
  const px = Uint8Array.from({ length: 2 * 2 * 2 }, (_, i) => i * 10);
  const bytes = writeDicom(baseElements({ rows: 2, cols: 2, frames: 2 }), { pixelData: px });
  const ds = parseDicom(bytes);
  const info = extractInfo(ds);
  const f1 = await decodeFrame(ds, info, 1);
  assert.deepEqual(Array.from(f1.data), [40, 50, 60, 70]);
  assert.equal(f1.min, 40);
  assert.equal(f1.max, 70);
});

test('unkomprimiert 16 Bit vorzeichenbehaftet mit 12 Bits Stored', async () => {
  const values = Int16Array.from([-2048, -1, 0, 2047]);
  // Obere 4 Bits mit Müll füllen (Overlay-Bits), um Maskierung/Vorzeichenerweiterung zu prüfen
  const raw = new Uint16Array(values.buffer).map((v) => (v & 0x0fff) | 0xa000);
  const els = baseElements({ rows: 2, cols: 2, bits: 16, signed: 1 }).map((e) =>
    e[0] === 0x0028 && e[1] === 0x0101 ? [0x0028, 0x0101, 'US', 12] : e[0] === 0x0028 && e[1] === 0x0102 ? [0x0028, 0x0102, 'US', 11] : e);
  const bytes = writeDicom(els, { pixelData: raw, bitsAllocated: 16 });
  const ds = parseDicom(bytes);
  const f = await decodeFrame(ds, extractInfo(ds), 0);
  assert.deepEqual(Array.from(f.data), [-2048, -1, 0, 2047]);
});

test('RGB planar wird verschachtelt', async () => {
  const planar = Uint8Array.from([1, 2, 10, 20, 100, 200]); // RR GG BB
  const bytes = writeDicom(baseElements({ rows: 1, cols: 2, spp: 3, photometric: 'RGB', extra: [[0x0028, 0x0006, 'US', 1]] }), { pixelData: planar });
  const ds = parseDicom(bytes);
  const f = await decodeFrame(ds, extractInfo(ds), 0);
  assert.equal(f.color, true);
  assert.deepEqual(Array.from(f.data), [1, 10, 100, 2, 20, 200]);
});

test('YBR_FULL_422 unkomprimiert → RGB', async () => {
  // Zwei graue Pixel (Cb = Cr = 128)
  const bytes = writeDicom(baseElements({ rows: 1, cols: 2, spp: 3, photometric: 'YBR_FULL_422' }), { pixelData: Uint8Array.from([50, 200, 128, 128]) });
  const ds = parseDicom(bytes);
  const f = await decodeFrame(ds, extractInfo(ds), 0);
  assert.deepEqual(Array.from(f.data), [50, 50, 50, 200, 200, 200]);
});

test('RLE 8 Bit Graustufen und 16 Bit', async () => {
  const px8 = Uint8Array.from([0, 0, 0, 0, 5, 6, 7, 8, 9, 9, 9, 1]);
  const info8 = { rows: 3, columns: 4, samplesPerPixel: 1, bitsAllocated: 8 };
  assert.deepEqual(Array.from(decodeRLE(rleFrame([px8]), info8)), Array.from(px8));

  const px16 = Uint16Array.from([0x1234, 0x1234, 0xabcd, 0x0001]);
  const hi = Uint8Array.from(px16, (v) => v >> 8);
  const lo = Uint8Array.from(px16, (v) => v & 0xff);
  const bytes = writeDicom(baseElements({ rows: 2, cols: 2, bits: 16 }), { transferSyntax: '1.2.840.10008.1.2.5', fragments: [rleFrame([hi, lo])] });
  const ds = parseDicom(bytes);
  const f = await decodeFrame(ds, extractInfo(ds), 0);
  assert.deepEqual(Array.from(f.data), Array.from(px16));
});

test('RLE RGB mehrere Frames', async () => {
  const frames = [0, 1].map((k) => [Uint8Array.from([10 + k, 11]), Uint8Array.from([20, 21]), Uint8Array.from([30, 31 + k])]);
  const bytes = writeDicom(baseElements({ rows: 1, cols: 2, frames: 2, spp: 3, photometric: 'RGB' }), {
    transferSyntax: '1.2.840.10008.1.2.5',
    fragments: frames.map(rleFrame),
  });
  const ds = parseDicom(bytes);
  const info = extractInfo(ds);
  const f = await decodeFrame(ds, info, 1);
  assert.deepEqual(Array.from(f.data), [11, 20, 30, 11, 21, 32]);
});

test('Fensterung und MONOCHROME1', () => {
  const info = { rescaleSlope: 1, rescaleIntercept: -1000, voiLutFunction: '', photometric: 'MONOCHROME1', windowCenter: [], windowWidth: [] };
  const frame = { width: 3, height: 1, color: false, data: Int16Array.from([0, 1000, 2000]), min: 0, max: 2000 };
  const win = defaultWindow(info, frame);
  assert.equal(win.wc, 0.5);
  const img = { data: new Uint8ClampedArray(12), width: 3, height: 1 };
  renderFrame(frame, info, { ...win, invert: false }, img);
  // MONOCHROME1: niedrige Werte hell
  assert.equal(img.data[0], 255);
  assert.equal(img.data[8], 0);
  assert.ok(Math.abs(img.data[4] - 127) <= 1);
});

test('Gruppierung: Multiframe einzeln, Einzelbilder nach Serie und Instance Number', () => {
  const mk = (path, extra) => new DicomEntry(null, path, {
    numberOfFrames: 1, transferSyntax: '1.2.840.10008.1.2.1', seriesInstanceUID: '1', studyInstanceUID: 's', rows: 2, columns: 2,
    samplesPerPixel: 1, instanceNumber: NaN, seriesNumber: 1, imageOrientation: [], imagePosition: [], patientID: 'p', patientName: 'x',
    studyDate: '', studyTime: '', fps: null, ...extra,
  });
  const entries = [
    mk('a/3.dcm', { instanceNumber: 3 }),
    mk('a/1.dcm', { instanceNumber: 1 }),
    mk('a/2.dcm', { instanceNumber: 2 }),
    mk('b/run.dcm', { numberOfFrames: 40, seriesInstanceUID: '2', seriesNumber: 2, fps: 15 }),
  ];
  const { stacks, tree } = buildStacks(entries);
  assert.equal(stacks.length, 2);
  assert.deepEqual(stacks[0].frames.map((f) => f.entry.path), ['a/1.dcm', 'a/2.dcm', 'a/3.dcm']);
  assert.equal(stacks[1].frameCount, 40);
  assert.equal(stacks[1].fps, 15);
  assert.equal(tree.length, 1);
});

test('Doppelte Dateien (gleiche SOP Instance UID) werden nur einmal gezählt', () => {
  const info = {
    numberOfFrames: 1, transferSyntax: '1.2.840.10008.1.2.1', seriesInstanceUID: '1', studyInstanceUID: 's', rows: 2, columns: 2,
    samplesPerPixel: 1, instanceNumber: 1, seriesNumber: 1, imageOrientation: [], imagePosition: [], patientID: 'p', patientName: 'x',
    studyDate: '', studyTime: '', fps: null, sopInstanceUID: '1.2.3',
  };
  const { stacks } = buildStacks([new DicomEntry(null, 'a/IM1', info), new DicomEntry(null, 'kopie/IM1', { ...info })]);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].frameCount, 1);
});

test('H.264 Annex B: NAL-Units werden an Startcodes getrennt', async () => {
  const { splitNalUnits } = await import('../src/dicom/video-dicom.js');
  const bytes = Uint8Array.from([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 6]);
  const units = splitNalUnits(bytes).map((u) => Array.from(bytes.subarray(u.start, u.end)));
  assert.deepEqual(units, [[0x67, 1, 2], [0x68, 3], [0x65, 4, 5, 6]]);
});

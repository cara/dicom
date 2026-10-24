// Parsen von DICOM-Dateien und Extraktion der für die Darstellung nötigen Metadaten.
import dicomParser from 'dicom-parser';
import { inflateSync } from 'fflate';

export const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATED_LE: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
  RLE: '1.2.840.10008.1.2.5',
};

const TS_NAMES = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless SV1',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-Lossless',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.4.201': 'HTJ2K Lossless',
  '1.2.840.10008.1.2.4.202': 'HTJ2K Lossless RPCL',
  '1.2.840.10008.1.2.4.203': 'HTJ2K',
  '1.2.840.10008.1.2.4.100': 'MPEG2 MP@ML',
  '1.2.840.10008.1.2.4.101': 'MPEG2 MP@HL',
  '1.2.840.10008.1.2.4.102': 'MPEG-4 AVC/H.264 HP@4.1',
  '1.2.840.10008.1.2.4.103': 'MPEG-4 AVC/H.264 BD',
  '1.2.840.10008.1.2.4.104': 'MPEG-4 AVC/H.264 HP@4.2 2D',
  '1.2.840.10008.1.2.4.105': 'MPEG-4 AVC/H.264 HP@4.2 3D',
  '1.2.840.10008.1.2.4.106': 'MPEG-4 AVC/H.264 Stereo HP@4.2',
  '1.2.840.10008.1.2.4.107': 'HEVC/H.265 Main',
  '1.2.840.10008.1.2.4.108': 'HEVC/H.265 Main 10',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
};

export function transferSyntaxName(uid) {
  return TS_NAMES[uid] || uid || 'unbekannt';
}

function inflater(byteArray, position) {
  // Deflated Explicit VR LE: alles nach den Meta-Informationen ist raw-deflate-komprimiert.
  const inflated = inflateSync(byteArray.subarray(position));
  const out = new Uint8Array(position + inflated.length);
  out.set(byteArray.subarray(0, position), 0);
  out.set(inflated, position);
  return out;
}

function looksLikeRawDicom(bytes) {
  // Dateien ohne Präambel/"DICM": beginnen typischerweise mit Gruppe 0x0002 oder 0x0008.
  if (bytes.length < 8) return false;
  const group = bytes[0] | (bytes[1] << 8);
  return group === 0x0002 || group === 0x0008;
}

/**
 * Parst ein DICOM-Bytearray. Wirft, wenn es sich nicht um DICOM handelt.
 * @param {Uint8Array} bytes
 * @param {{untilPixelData?: boolean}} [opts]
 */
export function parseDicom(bytes, opts = {}) {
  const options = { inflater };
  if (opts.untilPixelData) options.untilTag = 'x7fe00010';
  try {
    return dicomParser.parseDicom(bytes, options);
  } catch (err) {
    const msg = String(err && (err.exception || err.message || err));
    if (/DICM prefix not found/i.test(msg) && looksLikeRawDicom(bytes)) {
      return dicomParser.parseDicom(bytes, { ...options, TransferSyntaxUID: TS.IMPLICIT_LE });
    }
    throw err;
  }
}

function str(ds, tag) {
  const v = ds.string(tag);
  return v === undefined ? '' : v.trim();
}

function num(ds, tag, fallback) {
  const v = ds.floatString(tag);
  return Number.isFinite(v) ? v : fallback;
}

function multiNum(ds, tag) {
  const raw = ds.string(tag);
  if (!raw) return [];
  return raw.split('\\').map((s) => parseFloat(s)).filter((n) => Number.isFinite(n));
}

function us(ds, tag, fallback) {
  const el = ds.elements[tag];
  if (!el || el.length < 2) return fallback;
  return ds.uint16(tag);
}

/** Liest Palette-Color-LUTs (0028,1101-1203). */
function readPalette(ds) {
  const channels = ['x00281201', 'x00281202', 'x00281203'];
  const descs = ['x00281101', 'x00281102', 'x00281103'];
  const lut = [];
  for (let c = 0; c < 3; c++) {
    const descEl = ds.elements[descs[c]];
    const dataEl = ds.elements[channels[c]];
    if (!descEl || !dataEl) return null;
    let entries = ds.uint16(descs[c], 0);
    if (entries === 0) entries = 65536;
    const firstValueMapped = descEl.vr === 'SS' ? ds.int16(descs[c], 1) : ds.uint16(descs[c], 1);
    const bits = ds.uint16(descs[c], 2);
    const data = new Uint8Array(entries);
    const shift = bits > 8 ? 8 : 0;
    const bytesPerEntry = dataEl.length / entries;
    for (let i = 0; i < entries; i++) {
      if (bytesPerEntry >= 2) data[i] = ds.uint16(channels[c], i) >> shift;
      else data[i] = ds.byteArray[dataEl.dataOffset + i];
    }
    lut.push({ firstValueMapped, data });
  }
  return lut;
}

function patientName(ds) {
  return str(ds, 'x00100010').replace(/\^+/g, ' ').trim();
}

/**
 * Extrahiert alle für Gruppierung, Darstellung und Wiedergabe relevanten Angaben.
 * @param {*} ds dicomParser DataSet
 */
export function extractInfo(ds) {
  const transferSyntax = str(ds, 'x00020010') || TS.IMPLICIT_LE;
  const rows = us(ds, 'x00280010', 0);
  const columns = us(ds, 'x00280011', 0);
  const samplesPerPixel = us(ds, 'x00280002', 1);
  const bitsAllocated = us(ds, 'x00280100', 8);
  const bitsStored = us(ds, 'x00280101', bitsAllocated);
  const photometric = str(ds, 'x00280004').toUpperCase() || (samplesPerPixel === 3 ? 'RGB' : 'MONOCHROME2');
  const frameTimeVector = multiNum(ds, 'x00181065');

  const info = {
    transferSyntax,
    sopClassUID: str(ds, 'x00080016'),
    sopInstanceUID: str(ds, 'x00080018'),
    studyInstanceUID: str(ds, 'x0020000d'),
    seriesInstanceUID: str(ds, 'x0020000e'),
    patientName: patientName(ds),
    patientID: str(ds, 'x00100020'),
    patientBirthDate: str(ds, 'x00100030'),
    studyDate: str(ds, 'x00080020'),
    studyTime: str(ds, 'x00080030'),
    seriesDate: str(ds, 'x00080021'),
    acquisitionTime: str(ds, 'x00080032') || str(ds, 'x00080033'),
    studyDescription: str(ds, 'x00081030'),
    seriesDescription: str(ds, 'x0008103e'),
    protocolName: str(ds, 'x00181030'),
    institution: str(ds, 'x00080080'),
    manufacturer: str(ds, 'x00080070'),
    modelName: str(ds, 'x00081090'),
    modality: str(ds, 'x00080060'),
    seriesNumber: num(ds, 'x00200011', NaN),
    instanceNumber: num(ds, 'x00200013', NaN),
    acquisitionNumber: num(ds, 'x00200012', NaN),
    imagePosition: multiNum(ds, 'x00200032'),
    imageOrientation: multiNum(ds, 'x00200037'),
    sliceLocation: num(ds, 'x00201041', NaN),
    pixelSpacing: multiNum(ds, 'x00280030'),
    rows,
    columns,
    samplesPerPixel,
    photometric,
    bitsAllocated,
    bitsStored,
    highBit: us(ds, 'x00280102', bitsStored - 1),
    pixelRepresentation: us(ds, 'x00280103', 0),
    planarConfiguration: us(ds, 'x00280006', 0),
    numberOfFrames: Math.max(1, Math.round(num(ds, 'x00280008', 1))),
    rescaleSlope: num(ds, 'x00281053', 1) || 1,
    rescaleIntercept: num(ds, 'x00281052', 0),
    windowCenter: multiNum(ds, 'x00281050'),
    windowWidth: multiNum(ds, 'x00281051'),
    voiLutFunction: str(ds, 'x00281056').toUpperCase(),
    // Zeitangaben für Cine-Wiedergabe
    frameTime: num(ds, 'x00181063', NaN), // ms
    frameTimeVector,
    cineRate: num(ds, 'x00180040', NaN), // fps
    recommendedFrameRate: num(ds, 'x00082144', NaN), // fps
    // Kardiologisch interessante Angaben (Angiographie)
    positionerPrimaryAngle: num(ds, 'x00181510', NaN),
    positionerSecondaryAngle: num(ds, 'x00181511', NaN),
    heartRate: num(ds, 'x00181088', NaN),
    hasPixelData: !!(ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009),
    palette: null,
  };
  if (photometric === 'PALETTE COLOR') info.palette = readPalette(ds);
  info.fps = deriveFps(info);
  return info;
}

/** Bildrate aus den DICOM-Angaben (Frame Time, Cine Rate, Recommended Display Frame Rate, Frame Time Vector). */
export function deriveFps(info) {
  const candidates = [];
  if (info.frameTime > 0) candidates.push(1000 / info.frameTime);
  if (info.recommendedFrameRate > 0) candidates.push(info.recommendedFrameRate);
  if (info.cineRate > 0) candidates.push(info.cineRate);
  if (info.frameTimeVector.length > 1) {
    // Erstes Element ist laut Standard 0; Mittelwert der übrigen
    const rest = info.frameTimeVector.slice(1).filter((v) => v > 0);
    if (rest.length) candidates.push(1000 / (rest.reduce((a, b) => a + b, 0) / rest.length));
  }
  const fps = candidates.find((v) => Number.isFinite(v) && v > 0.1 && v < 1000);
  return fps ? Math.round(fps * 100) / 100 : null;
}

export function isVideoTransferSyntax(uid) {
  return /^1\.2\.840\.10008\.1\.2\.4\.(10[0-8])$/.test(uid);
}

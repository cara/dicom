// Dekodierung eines Frames in ein einheitliches Format:
//   Graustufen: { color: false, data: TypedArray mit gespeicherten Pixelwerten, min, max }
//   Farbe:      { color: true,  data: Uint8Array RGB verschachtelt }
import { Decoder as LosslessDecoder } from 'jpeg-lossless-decoder-js';
import { getFrameBytes } from './frames.js';
import { decodeRLE } from './rle.js';
import { TS, transferSyntaxName, isVideoTransferSyntax } from './parse.js';
import { planarToInterleaved } from './util.js';

const JPEG_BROWSER = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51']);
const JPEG_LOSSLESS = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);
const JPEG_LS = new Set(['1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81']);
const J2K = new Set([
  '1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91',
  '1.2.840.10008.1.2.4.201', '1.2.840.10008.1.2.4.202', '1.2.840.10008.1.2.4.203',
]);
const UNCOMPRESSED = new Set([TS.IMPLICIT_LE, TS.EXPLICIT_LE, TS.DEFLATED_LE, TS.EXPLICIT_BE]);

export function isSupportedTransferSyntax(uid) {
  return UNCOMPRESSED.has(uid) || uid === TS.RLE || JPEG_BROWSER.has(uid) || JPEG_LOSSLESS.has(uid) ||
    JPEG_LS.has(uid) || J2K.has(uid);
}

/** Kopiert in einen ausgerichteten Puffer und interpretiert als passenden TypedArray. */
function toTypedArray(bytes, bitsAllocated, signed, bigEndian, isFloat) {
  const copy = bytes.slice();
  if (bigEndian && bitsAllocated > 8) {
    const step = bitsAllocated / 8;
    for (let i = 0; i + step <= copy.length; i += step) {
      for (let a = i, b = i + step - 1; a < b; a++, b--) {
        const t = copy[a]; copy[a] = copy[b]; copy[b] = t;
      }
    }
  }
  const buf = copy.buffer;
  const usable = (n) => Math.floor(copy.length / n) * n;
  switch (bitsAllocated) {
    case 8: return signed ? new Int8Array(buf) : copy;
    case 16: return signed ? new Int16Array(buf, 0, usable(2) / 2) : new Uint16Array(buf, 0, usable(2) / 2);
    case 32:
      if (isFloat) return new Float32Array(buf, 0, usable(4) / 4);
      return signed ? new Int32Array(buf, 0, usable(4) / 4) : new Uint32Array(buf, 0, usable(4) / 4);
    default: throw new Error(`Bits Allocated = ${bitsAllocated} wird nicht unterstützt`);
  }
}

function unpackBits(bytes, info, frameIndex) {
  const n = info.rows * info.columns;
  const out = new Uint8Array(n);
  const bitOffset = n * frameIndex;
  for (let i = 0; i < n; i++) {
    const bit = bitOffset + i;
    out[i] = (bytes[bit >> 3] >> (bit & 7)) & 1;
  }
  return out;
}

/** Maskiert ungenutzte Bits und führt ggf. Vorzeichenerweiterung durch. */
function applyBitsStored(data, info) {
  const { bitsStored, pixelRepresentation } = info;
  const containerBits = data.BYTES_PER_ELEMENT * 8;
  if (data instanceof Float32Array || bitsStored >= containerBits || bitsStored <= 0) return data;
  const mask = (1 << bitsStored) - 1;
  if (pixelRepresentation === 1) {
    const signBit = 1 << (bitsStored - 1);
    const signed = data instanceof Int16Array || data instanceof Int8Array || data instanceof Int32Array
      ? data
      : new (containerBits === 8 ? Int8Array : containerBits === 16 ? Int16Array : Int32Array)(data.buffer, data.byteOffset, data.length);
    for (let i = 0; i < signed.length; i++) {
      const v = signed[i] & mask;
      signed[i] = v & signBit ? v - (mask + 1) : v;
    }
    return signed;
  }
  let needsMask = false;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > mask || data[i] < 0) { needsMask = true; break; }
  }
  if (needsMask) for (let i = 0; i < data.length; i++) data[i] &= mask;
  return data;
}

function minMax(data) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  return { min, max };
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function ybrFullToRgb(src) {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const y = src[i];
    const cb = src[i + 1] - 128;
    const cr = src[i + 2] - 128;
    out[i] = clamp8(y + 1.402 * cr);
    out[i + 1] = clamp8(y - 0.344136 * cb - 0.714136 * cr);
    out[i + 2] = clamp8(y + 1.772 * cb);
  }
  return out;
}

function ybr422ToRgb(src, pixels) {
  const out = new Uint8Array(pixels * 3);
  for (let i = 0, p = 0; p < pixels && i + 3 < src.length; i += 4, p += 2) {
    const cb = src[i + 2] - 128;
    const cr = src[i + 3] - 128;
    for (let k = 0; k < 2 && p + k < pixels; k++) {
      const y = src[i + k];
      const o = (p + k) * 3;
      out[o] = clamp8(y + 1.402 * cr);
      out[o + 1] = clamp8(y - 0.344136 * cb - 0.714136 * cr);
      out[o + 2] = clamp8(y + 1.772 * cb);
    }
  }
  return out;
}

function paletteToRgb(indices, palette) {
  const out = new Uint8Array(indices.length * 3);
  const [r, g, b] = palette;
  const last = r.data.length - 1;
  for (let i = 0; i < indices.length; i++) {
    let idx = indices[i] - r.firstValueMapped;
    idx = idx < 0 ? 0 : idx > last ? last : idx;
    out[i * 3] = r.data[idx];
    out[i * 3 + 1] = g.data[idx];
    out[i * 3 + 2] = b.data[idx];
  }
  return out;
}

function to8bitRgb(data) {
  if (data instanceof Uint8Array) return data;
  const { max } = minMax(data);
  const shift = max > 255 ? Math.max(0, Math.ceil(Math.log2(max + 1)) - 8) : 0;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] >> shift;
  return out;
}

/** Liest die Präzision aus dem SOF-Marker eines JPEG-Streams. */
function jpegPrecision(bytes) {
  for (let i = 2; i + 4 < bytes.length;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return bytes[i + 4];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return 8;
}

let scratchCanvas = null;

async function decodeWithBrowser(bytes, info) {
  const precision = jpegPrecision(bytes);
  if (precision > 8) {
    throw new Error(`JPEG mit ${precision} Bit Präzision wird vom Browser nicht unterstützt`);
  }
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  let source;
  if (typeof createImageBitmap === 'function') {
    source = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } else {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('JPEG konnte nicht dekodiert werden'));
      img.src = URL.createObjectURL(blob);
    });
  }
  const w = source.width;
  const h = source.height;
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = w;
  scratchCanvas.height = h;
  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  if (source.close) source.close();
  else if (source.src) URL.revokeObjectURL(source.src);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  if (info.samplesPerPixel === 1) {
    const gray = new Uint8Array(n);
    for (let i = 0; i < n; i++) gray[i] = rgba[i * 4];
    return { width: w, height: h, components: 1, pixels: gray };
  }
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width: w, height: h, components: 3, pixels: rgb };
}

function decodeLossless(bytes, info) {
  const decoder = new LosslessDecoder();
  const buf = bytes.slice().buffer;
  const numBytes = info.bitsAllocated <= 8 ? 1 : 2;
  let out = decoder.decode(buf, 0, buf.byteLength, numBytes);
  if (info.pixelRepresentation === 1 && out instanceof Uint16Array) out = new Int16Array(out.buffer, out.byteOffset, out.length);
  if (info.pixelRepresentation === 1 && out instanceof Uint8Array && info.samplesPerPixel === 1) out = new Int8Array(out.buffer, out.byteOffset, out.length);
  return { width: decoder.xDim || info.columns, height: decoder.yDim || info.rows, components: info.samplesPerPixel, pixels: out };
}

/**
 * Dekodiert einen Frame.
 * @returns {Promise<{width:number,height:number,color:boolean,data:ArrayLike<number>,min?:number,max?:number}>}
 */
export async function decodeFrame(ds, info, frameIndex) {
  const ts = info.transferSyntax;
  if (isVideoTransferSyntax(ts)) {
    throw new Error(`${transferSyntaxName(ts)}: Video-DICOM wird über den Videoplayer abgespielt`);
  }
  if (!isSupportedTransferSyntax(ts)) {
    throw new Error(`Transfer Syntax nicht unterstützt: ${transferSyntaxName(ts)}`);
  }
  const bytes = getFrameBytes(ds, info, frameIndex);
  const width = info.columns;
  const height = info.rows;
  const pixelCount = width * height;
  const signed = info.pixelRepresentation === 1;
  let data;
  let decodedColorSpaceIsRgb = false; // true, wenn der Codec bereits RGB liefert

  if (UNCOMPRESSED.has(ts)) {
    if (info.bitsAllocated === 1) {
      data = unpackBits(bytes, info, frameIndex);
    } else if (info.photometric === 'YBR_FULL_422' && info.samplesPerPixel === 3) {
      return { width, height, color: true, data: ybr422ToRgb(bytes, pixelCount) };
    } else {
      const isFloat = !!ds.elements.x7fe00008;
      data = toTypedArray(bytes, info.bitsAllocated, signed, ts === TS.EXPLICIT_BE, isFloat);
      if (info.samplesPerPixel > 1 && info.planarConfiguration === 1) data = planarToInterleaved(data, info.samplesPerPixel);
    }
  } else if (ts === TS.RLE) {
    data = toTypedArray(decodeRLE(bytes, info), info.bitsAllocated, signed, false, false);
  } else {
    let res;
    if (JPEG_BROWSER.has(ts)) {
      res = await decodeWithBrowser(bytes, info);
      decodedColorSpaceIsRgb = true;
    } else if (JPEG_LOSSLESS.has(ts)) {
      res = decodeLossless(bytes, info);
    } else if (JPEG_LS.has(ts)) {
      const { decodeJLS } = await import('./codecs.js');
      res = await decodeJLS(bytes, signed);
    } else {
      const { decodeJ2K } = await import('./codecs.js');
      res = await decodeJ2K(bytes);
      // J2K mit YBR_ICT/YBR_RCT liefert nach der inversen Komponententransformation RGB
      decodedColorSpaceIsRgb = true;
      if (signed && res.pixels instanceof Uint16Array) res.pixels = new Int16Array(res.pixels.buffer);
    }
    data = res.pixels;
    if (res.width !== width || res.height !== height) {
      // Manche Dateien haben abweichende Header-Angaben – den Codec-Werten vertrauen
      return finish({ ...info, columns: res.width, rows: res.height }, data, res.width, res.height, decodedColorSpaceIsRgb);
    }
  }
  return finish(info, data, width, height, decodedColorSpaceIsRgb);
}

function finish(info, data, width, height, decodedColorSpaceIsRgb) {
  const pixelCount = width * height;
  if (info.samplesPerPixel === 3) {
    let rgb = to8bitRgb(data.length > pixelCount * 3 ? data.subarray(0, pixelCount * 3) : data);
    if (!decodedColorSpaceIsRgb && info.photometric === 'YBR_FULL') rgb = ybrFullToRgb(rgb);
    return { width, height, color: true, data: rgb };
  }
  if (data.length > pixelCount) data = data.subarray(0, pixelCount);
  if (info.photometric === 'PALETTE COLOR' && info.palette) {
    return { width, height, color: true, data: paletteToRgb(data, info.palette) };
  }
  if (info.bitsAllocated > 1) data = applyBitsStored(data, info);
  const { min, max } = minMax(data);
  return { width, height, color: false, data, min, max };
}

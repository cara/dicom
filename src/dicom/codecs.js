// Lazy geladene WebAssembly-Codecs (JPEG 2000 / HTJ2K via OpenJPEG, JPEG-LS via CharLS).
// Die .wasm-Dateien werden beim Build eingebettet, damit die App auch offline als einzelne HTML-Datei läuft.
import OpenJPEGWASM from '@cornerstonejs/codec-openjpeg/decodewasmjs';
import openjpegWasm from '@cornerstonejs/codec-openjpeg/decodewasm';
import CharLSWASM from '@cornerstonejs/codec-charls/decodewasmjs';
import charlsWasm from '@cornerstonejs/codec-charls/decodewasm';
import { planarToInterleaved } from './util.js';

let openjpeg = null;
let charls = null;

function init(factory, wasmBinary) {
  return factory({
    wasmBinary,
    locateFile: (f) => f,
    print: () => {},
    printErr: () => {},
  });
}

function getOpenJPEG() {
  if (!openjpeg) openjpeg = init(OpenJPEGWASM, openjpegWasm);
  return openjpeg;
}

function getCharLS() {
  if (!charls) charls = init(CharLSWASM, charlsWasm);
  return charls;
}

function copyOut(decoded, bitsPerSample, signed) {
  // Der dekodierte Puffer ist ein View in den WASM-Speicher → kopieren
  const bytes = new Uint8Array(decoded.length);
  bytes.set(decoded);
  if (bitsPerSample <= 8) return signed ? new Int8Array(bytes.buffer) : bytes;
  return signed ? new Int16Array(bytes.buffer) : new Uint16Array(bytes.buffer);
}

/** JPEG 2000 / HTJ2K */
export async function decodeJ2K(data) {
  const codec = await getOpenJPEG();
  const decoder = new codec.J2KDecoder();
  try {
    const encoded = decoder.getEncodedBuffer(data.length);
    encoded.set(data);
    decoder.decode();
    const fi = decoder.getFrameInfo();
    return {
      width: fi.width,
      height: fi.height,
      components: fi.componentCount,
      pixels: copyOut(decoder.getDecodedBuffer(), fi.bitsPerSample, fi.isSigned),
    };
  } finally {
    decoder.delete();
  }
}

/** JPEG-LS */
export async function decodeJLS(data, signed) {
  const codec = await getCharLS();
  const decoder = new codec.JpegLSDecoder();
  try {
    const encoded = decoder.getEncodedBuffer(data.length);
    encoded.set(data);
    decoder.decode();
    const fi = decoder.getFrameInfo();
    const interleave = decoder.getInterleaveMode(); // 0 = planar
    let pixels = copyOut(decoder.getDecodedBuffer(), fi.bitsPerSample, signed);
    if (fi.componentCount === 3 && interleave === 0) pixels = planarToInterleaved(pixels, 3);
    return { width: fi.width, height: fi.height, components: fi.componentCount, pixels };
  } finally {
    decoder.delete();
  }
}

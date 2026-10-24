// Zugriff auf die (komprimierten oder unkomprimierten) Bytes eines einzelnen Frames.
import dicomParser from 'dicom-parser';

function pixelDataElement(ds) {
  return ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009;
}

/** Bytes pro Frame bei unkomprimierten Daten (Bits können < 8 sein, z. B. 1-Bit-Masken). */
export function uncompressedFrameSize(info) {
  // YBR_FULL_422 unkomprimiert: 2 Pixel teilen sich ein Cb/Cr-Paar → 2 Samples pro Pixel
  const samples = info.photometric === 'YBR_FULL_422' ? 2 : info.samplesPerPixel;
  return Math.ceil((info.rows * info.columns * samples * info.bitsAllocated) / 8);
}

function startsWithFrameMarker(bytes, offset) {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === 0xff && (b1 === 0xd8 || b1 === 0x4f)) return true; // JPEG/JPEG-LS SOI, J2K SOC
  // JP2-Signatur-Box: 00 00 00 0C 6A 50 20 20
  return b0 === 0x00 && b1 === 0x00 && bytes[offset + 2] === 0x00 && bytes[offset + 3] === 0x0c &&
    bytes[offset + 4] === 0x6a && bytes[offset + 5] === 0x50;
}

const fragmentMapCache = new WeakMap();

/** Zuordnung Frame → Fragmentbereich, wenn keine Basic Offset Table vorliegt. */
function fragmentMap(ds, el, numberOfFrames) {
  let map = fragmentMapCache.get(el);
  if (map) return map;
  const frags = el.fragments;
  map = [];
  if (frags.length === numberOfFrames) {
    for (let i = 0; i < frags.length; i++) map.push([i, 1]);
  } else {
    let start = -1;
    for (let i = 0; i < frags.length; i++) {
      const offset = frags[i].position;
      if (startsWithFrameMarker(ds.byteArray, offset) || start === -1) {
        if (start !== -1) map.push([start, i - start]);
        start = i;
      }
    }
    if (start !== -1) map.push([start, frags.length - start]);
    if (map.length !== numberOfFrames && numberOfFrames === 1) map = [[0, frags.length]];
  }
  fragmentMapCache.set(el, map);
  return map;
}

/**
 * Liefert die Rohbytes eines Frames.
 * @returns {Uint8Array}
 */
export function getFrameBytes(ds, info, frameIndex) {
  const el = pixelDataElement(ds);
  if (!el) throw new Error('Keine Pixeldaten vorhanden');
  if (el.encapsulatedPixelData) {
    if (el.basicOffsetTable && el.basicOffsetTable.length) {
      return dicomParser.readEncapsulatedImageFrame(ds, el, frameIndex);
    }
    const map = fragmentMap(ds, el, info.numberOfFrames);
    const entry = map[frameIndex];
    if (!entry) throw new Error(`Frame ${frameIndex + 1} nicht in den Pixeldaten gefunden`);
    return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, entry[0], entry[1]);
  }
  const size = uncompressedFrameSize(info);
  if (info.bitsAllocated === 1) {
    // Bitweise gepackte Frames können mitten im Byte beginnen → komplette Pixeldaten liefern
    return new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + el.dataOffset, el.length);
  }
  const offset = el.dataOffset + size * frameIndex;
  if (offset + size > el.dataOffset + el.length + 1) {
    throw new Error(`Frame ${frameIndex + 1} liegt außerhalb der Pixeldaten (Datei unvollständig?)`);
  }
  const avail = Math.min(size, ds.byteArray.length - offset);
  return new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + offset, avail);
}

/** Alle Fragmente eines Video-Streams (MPEG/H.264) zu einem Bytearray zusammenfügen. */
export function getVideoStream(ds) {
  const el = pixelDataElement(ds);
  if (!el || !el.encapsulatedPixelData) throw new Error('Kein gekapselter Videostream');
  return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, 0, el.fragments.length);
}

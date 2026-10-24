// DICOM RLE Lossless (PS3.5 Annex G). Ergebnis ist pixelweise verschachtelt (wie unkomprimiert, Planar Configuration 0).

/**
 * @param {Uint8Array} data komprimierter Frame
 * @param {{rows:number, columns:number, samplesPerPixel:number, bitsAllocated:number}} info
 * @returns {Uint8Array} dekomprimierte Bytes in Little-Endian-Reihenfolge, Samples verschachtelt
 */
export function decodeRLE(data, info) {
  const { rows, columns, samplesPerPixel } = info;
  const bytesPerSample = info.bitsAllocated / 8;
  const pixels = rows * columns;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numSegments = view.getUint32(0, true);
  const expected = samplesPerPixel * bytesPerSample;
  if (numSegments !== expected) {
    throw new Error(`RLE: ${numSegments} Segmente, erwartet ${expected}`);
  }
  const offsets = [];
  for (let i = 0; i < numSegments; i++) offsets.push(view.getUint32(4 + i * 4, true));
  offsets.push(data.length);

  const out = new Uint8Array(pixels * expected);
  const stride = expected;
  for (let s = 0; s < numSegments; s++) {
    // Segmentreihenfolge: je Sample zuerst das höchstwertige Byte
    const sample = Math.floor(s / bytesPerSample);
    const byteInSample = bytesPerSample - 1 - (s % bytesPerSample);
    let outPos = sample * bytesPerSample + byteInSample;
    let inPos = offsets[s];
    const end = offsets[s + 1];
    let written = 0;
    while (inPos < end && written < pixels) {
      const n = data[inPos++];
      if (n < 128) {
        // n+1 Literal-Bytes
        const count = Math.min(n + 1, pixels - written, end - inPos);
        for (let k = 0; k < count; k++) {
          out[outPos] = data[inPos++];
          outPos += stride;
        }
        written += count;
      } else if (n > 128) {
        // Byte (257-n)-mal wiederholen
        const count = Math.min(257 - n, pixels - written);
        const value = data[inPos++];
        for (let k = 0; k < count; k++) {
          out[outPos] = value;
          outPos += stride;
        }
        written += count;
      }
      // n === 128: no-op
    }
  }
  return out;
}

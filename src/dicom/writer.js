// Minimaler DICOM-Writer (Explicit VR Little Endian) – für die Demo-Daten und Tests.

const enc = new TextEncoder();

const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UI', 'UT', 'UC']);
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'UC', 'UR', 'OD', 'OL']);

function pad(bytes, vr) {
  if (bytes.length % 2 === 0) return bytes;
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = vr === 'UI' || vr === 'OB' ? 0 : 0x20;
  return out;
}

function valueBytes(vr, value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (STRING_VRS.has(vr)) return enc.encode(Array.isArray(value) ? value.join('\\') : String(value));
  const values = Array.isArray(value) ? value : [value];
  const size = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8 }[vr];
  if (!size) throw new Error(`VR ${vr} nicht unterstützt`);
  const buf = new DataView(new ArrayBuffer(size * values.length));
  values.forEach((v, i) => {
    const o = i * size;
    if (vr === 'US') buf.setUint16(o, v, true);
    else if (vr === 'SS') buf.setInt16(o, v, true);
    else if (vr === 'UL') buf.setUint32(o, v, true);
    else if (vr === 'SL') buf.setInt32(o, v, true);
    else if (vr === 'FL') buf.setFloat32(o, v, true);
    else buf.setFloat64(o, v, true);
  });
  return new Uint8Array(buf.buffer);
}

function element(group, elem, vr, value, undefinedLength = false) {
  const data = undefinedLength ? value : pad(valueBytes(vr, value), vr);
  const long = LONG_VRS.has(vr);
  const header = new DataView(new ArrayBuffer(long ? 12 : 8));
  header.setUint16(0, group, true);
  header.setUint16(2, elem, true);
  header.setUint8(4, vr.charCodeAt(0));
  header.setUint8(5, vr.charCodeAt(1));
  if (long) header.setUint32(8, undefinedLength ? 0xffffffff : data.length, true);
  else header.setUint16(6, data.length, true);
  return [new Uint8Array(header.buffer), data];
}

function item(bytes, tagElem = 0xe000) {
  const h = new DataView(new ArrayBuffer(8));
  h.setUint16(0, 0xfffe, true);
  h.setUint16(2, tagElem, true);
  h.setUint32(4, bytes.length, true);
  return [new Uint8Array(h.buffer), bytes];
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Erzeugt eine DICOM-Datei.
 * @param {Array<[number, number, string, any]>} elements [group, element, VR, value] – ohne Pixeldaten
 * @param {{pixelData?: Uint8Array|ArrayBufferView, fragments?: Uint8Array[], transferSyntax?: string}} opts
 */
export function writeDicom(elements, opts = {}) {
  const ts = opts.transferSyntax || '1.2.840.10008.1.2.1';
  const sopClass = elements.find((e) => e[0] === 0x0008 && e[1] === 0x0016)?.[3] || '1.2.840.10008.5.1.4.1.1.7';
  const sopInst = elements.find((e) => e[0] === 0x0008 && e[1] === 0x0018)?.[3] || '1.2.3.4';
  const metaBody = concat([
    ...element(0x0002, 0x0001, 'OB', new Uint8Array([0, 1])),
    ...element(0x0002, 0x0002, 'UI', sopClass),
    ...element(0x0002, 0x0003, 'UI', sopInst),
    ...element(0x0002, 0x0010, 'UI', ts),
    ...element(0x0002, 0x0012, 'UI', '1.2.826.0.1.3680043.10.1'),
  ]);
  const parts = [new Uint8Array(128), enc.encode('DICM'), ...element(0x0002, 0x0000, 'UL', metaBody.length), metaBody];
  const sorted = [...elements].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [g, e, vr, v] of sorted) parts.push(...element(g, e, vr, v));
  if (opts.fragments) {
    const seq = [...item(new Uint8Array(0))];
    for (const f of opts.fragments) seq.push(...item(pad(f, 'OB')));
    seq.push(...item(new Uint8Array(0), 0xe0dd));
    parts.push(...element(0x7fe0, 0x0010, 'OB', concat(seq), true));
  } else if (opts.pixelData) {
    parts.push(...element(0x7fe0, 0x0010, opts.bitsAllocated > 8 ? 'OW' : 'OB', opts.pixelData));
  }
  return concat(parts);
}

/** Zufällige, aber gültige UID (Präfix 2.25 = UUID-basiert). */
export function makeUid() {
  let s = '2.25.';
  for (let i = 0; i < 3; i++) s += Math.floor(Math.random() * 1e12).toString();
  return s.slice(0, 64);
}

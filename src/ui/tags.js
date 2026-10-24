// Darstellung aller DICOM-Attribute eines Datensatzes als Tabelle.
import { tagName, formatTag } from '../dicom/dictionary.js';

const TEXT_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UI', 'UT', 'UC', 'UR']);
const PRIVACY_TAGS = new Set(['x00100010', 'x00100020', 'x00100030', 'x00101040', 'x00102154']);

function valueOf(ds, el) {
  const vr = el.vr;
  const n = el.length;
  if (el.tag === 'x7fe00010' || el.tag === 'x7fe00008') {
    return el.encapsulatedPixelData ? `[gekapselt, ${el.fragments?.length || 0} Fragmente]` : `[${n.toLocaleString('de-DE')} Bytes]`;
  }
  try {
    if (vr && TEXT_VRS.has(vr)) return ds.string(el.tag) ?? '';
    const read = (fn, size) => {
      const count = Math.min(n / size, 16);
      const vals = [];
      for (let i = 0; i < count; i++) vals.push(ds[fn](el.tag, i));
      return vals.join('\\') + (n / size > 16 ? ' …' : '');
    };
    switch (vr) {
      case 'US': return read('uint16', 2);
      case 'SS': return read('int16', 2);
      case 'UL': return read('uint32', 4);
      case 'SL': return read('int32', 4);
      case 'FL': return read('float', 4);
      case 'FD': return read('double', 8);
      case 'AT': return formatTag(`x${ds.attributeTag(el.tag)?.slice(1) || ''}`);
      default:
        break;
    }
    if (!vr && n > 0 && n <= 256) {
      // Implicit VR ohne Wörterbuch: druckbaren Text anzeigen
      const s = ds.string(el.tag);
      if (s && /^[\x20-\x7e -ÿ]*$/.test(s)) return s;
    }
  } catch {
    // ignorieren
  }
  return n ? `[${n.toLocaleString('de-DE')} Bytes]` : '';
}

/**
 * @param {*} ds dicomParser DataSet
 * @param {{hidePatient?: boolean}} [opts]
 * @returns {{tag:string, name:string, vr:string, value:string, depth:number}[]}
 */
export function listElements(ds, opts = {}, depth = 0, out = []) {
  const tags = Object.keys(ds.elements).sort();
  for (const tag of tags) {
    const el = ds.elements[tag];
    let value = el.items ? `${el.items.length} Element(e)` : valueOf(ds, el);
    if (opts.hidePatient && PRIVACY_TAGS.has(tag)) value = '••••••';
    out.push({ tag: formatTag(tag), name: tagName(tag), vr: el.vr || (el.items ? 'SQ' : ''), value, depth });
    if (el.items && depth < 4) {
      el.items.forEach((item, idx) => {
        out.push({ tag: '', name: `Item ${idx + 1}`, vr: '', value: '', depth: depth + 1 });
        if (item.dataSet) listElements(item.dataSet, opts, depth + 2, out);
      });
    }
  }
  return out;
}

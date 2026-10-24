// Video-DICOM (MPEG-4 AVC/H.264, HEVC) über WebCodecs in Einzelbilder dekodieren.
import { getVideoStream } from './frames.js';

const H264 = /^1\.2\.840\.10008\.1\.2\.4\.10[2-6]$/;
const HEVC = /^1\.2\.840\.10008\.1\.2\.4\.10[78]$/;

export function videoStreamExtension(ts) {
  if (H264.test(ts)) return 'h264';
  if (HEVC.test(ts)) return 'h265';
  return 'mpg';
}

/** NAL-Units eines Annex-B-Bytestroms (Startcodes 00 00 01 / 00 00 00 01). */
export function splitNalUnits(bytes) {
  const units = [];
  let start = -1;
  const n = bytes.length;
  for (let i = 0; i + 2 < n; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && bytes[end - 1] === 0) end--; // 4-Byte-Startcode
        units.push({ start, end });
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < n) units.push({ start, end: n });
  return units;
}

/** Gruppiert NAL-Units zu Access Units (je ein Bild). */
function accessUnits(bytes, hevc) {
  const nals = splitNalUnits(bytes);
  const aus = [];
  let current = null;
  let sawVcl = false;
  for (const nal of nals) {
    const h = bytes[nal.start];
    const type = hevc ? (h >> 1) & 0x3f : h & 0x1f;
    const isVcl = hevc ? type < 32 : type >= 1 && type <= 5;
    // HEVC: first_slice_segment_in_pic_flag im ersten Bit nach dem 2-Byte-Header; H.264: first_mb_in_slice == 0 → erstes Bit = 1
    const firstSlice = isVcl && (bytes[nal.start + (hevc ? 2 : 1)] & 0x80) !== 0;
    const isAud = hevc ? type === 35 : type === 9;
    const isParam = hevc ? type >= 32 && type <= 40 : type === 6 || type === 7 || type === 8;
    if (!current || isAud || ((isParam || firstSlice) && sawVcl)) {
      current = { nals: [], key: false };
      aus.push(current);
      sawVcl = false;
    }
    current.nals.push(nal);
    if (isVcl) {
      sawVcl = true;
      if (hevc ? type >= 16 && type <= 21 : type === 5) current.key = true;
    }
    if (!hevc && type === 7 && !aus.sps) aus.sps = bytes.subarray(nal.start, nal.end);
  }
  return aus;
}

function concatNals(bytes, nals) {
  const len = nals.reduce((s, n) => s + 4 + n.end - n.start, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const n of nals) {
    out.set([0, 0, 0, 1], o);
    out.set(bytes.subarray(n.start, n.end), o + 4);
    o += 4 + n.end - n.start;
  }
  return out;
}

function hex2(v) {
  return v.toString(16).padStart(2, '0');
}

function isMp4Container(bytes) {
  return bytes.length > 12 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp';
}

/**
 * Dekodiert einen Videostrom in RGB-Frames.
 * @returns {Promise<{frames: {width:number,height:number,color:true,data:Uint8Array}[]}>}
 */
export async function decodeVideoDicom(ds, info, onProgress) {
  const ts = info.transferSyntax;
  const stream = getVideoStream(ds);
  if (isMp4Container(stream)) throw new Error('Video liegt als MP4-Container vor – bitte über „Video extrahieren“ speichern');
  if (typeof VideoDecoder !== 'function') throw new Error('Dieser Browser unterstützt kein WebCodecs (Video-Dekodierung)');
  const hevc = HEVC.test(ts);
  if (!hevc && !H264.test(ts)) throw new Error('MPEG-2-Video kann im Browser nicht dekodiert werden – bitte über „Video extrahieren“ speichern');

  const aus = accessUnits(stream, hevc);
  const firstKey = aus.findIndex((a) => a.key);
  if (firstKey < 0) throw new Error('Kein Schlüsselbild im Videostrom gefunden');

  let codecs;
  if (hevc) {
    codecs = ['hev1.1.6.L93.B0', 'hev1.1.6.L120.90', 'hev1.1.6.L150.90', 'hev1.2.4.L120.90', 'hev1.2.4.L150.90'];
  } else {
    const sps = aus.sps;
    codecs = sps ? [`avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`, 'avc1.640033', 'avc1.64002a'] : ['avc1.640033', 'avc1.64002a'];
  }
  let config = null;
  for (const codec of codecs) {
    try {
      const res = await VideoDecoder.isConfigSupported({ codec });
      if (res.supported) { config = res.config; break; }
    } catch {
      // nächster Kandidat
    }
  }
  if (!config) throw new Error(`Der Browser kann diesen ${hevc ? 'HEVC' : 'H.264'}-Stream nicht dekodieren`);

  const frames = [];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let decodeError = null;
  const decoder = new VideoDecoder({
    output: (vf) => {
      try {
        const w = vf.displayWidth;
        const h = vf.displayHeight;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        ctx.drawImage(vf, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        const rgb = new Uint8Array(w * h * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
          rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
        }
        frames.push({ width: w, height: h, color: true, data: rgb });
      } finally {
        vf.close();
      }
    },
    error: (e) => { decodeError = e; },
  });
  decoder.configure(config);
  const usable = aus.slice(firstKey);
  for (let i = 0; i < usable.length; i++) {
    if (decodeError) break;
    const au = usable[i];
    decoder.decode(new EncodedVideoChunk({ type: au.key ? 'key' : 'delta', timestamp: i * 33333, data: concatNals(stream, au.nals) }));
    while (decoder.decodeQueueSize > 16) await new Promise((r) => setTimeout(r, 1));
    if (i % 10 === 0) onProgress?.(i / usable.length);
  }
  if (!decodeError) await decoder.flush().catch((e) => { decodeError = e; });
  decoder.close();
  if (decodeError && !frames.length) throw new Error(`Video-Dekodierung fehlgeschlagen: ${decodeError.message || decodeError}`);
  onProgress?.(1);
  return { frames };
}

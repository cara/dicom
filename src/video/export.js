// Video-Export: MP4 (H.264) über WebCodecs + mp4-muxer, Rückfall auf WebM über MediaRecorder.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { frameToCanvas } from '../viewer/render.js';

export const QUALITY = {
  low: { label: 'Klein', bpp: 0.06 },
  medium: { label: 'Mittel', bpp: 0.12 },
  high: { label: 'Hoch', bpp: 0.25 },
  max: { label: 'Sehr hoch', bpp: 0.5 },
};

// H.264-Profile/Level, absteigend nach Kompatibilität (Baseline läuft auch auf alten Geräten / PowerPoint)
const AVC_CANDIDATES = [
  'avc1.640028', 'avc1.4d0028', 'avc1.42e028', // Level 4.0 (bis 2048×1024)
  'avc1.64002a', 'avc1.4d002a', 'avc1.42e02a', // Level 4.2
  'avc1.640032', 'avc1.4d0032', 'avc1.42e032', // Level 5.0
  'avc1.640033', 'avc1.4d0033', 'avc1.42e033', // Level 5.1
  'avc1.640034', 'avc1.42e034',
];

export function supportsMp4() {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

export function supportsWebm() {
  return typeof MediaRecorder === 'function' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

async function pickAvcConfig(width, height, fps, bitrate) {
  for (const codec of AVC_CANDIDATES) {
    for (const hardwareAcceleration of ['no-preference', 'prefer-software']) {
      const config = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: { format: 'avc' }, latencyMode: 'quality' };
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res.supported) return res.config;
      } catch {
        // nächster Kandidat
      }
    }
  }
  return null;
}

/** Zielgröße: gerade Kantenlängen (H.264), optional begrenzt. */
export function outputSize(width, height, { maxSize = 0, scale = 1 } = {}) {
  let w = width * scale;
  let h = height * scale;
  if (maxSize && Math.max(w, h) > maxSize) {
    const k = maxSize / Math.max(w, h);
    w *= k;
    h *= k;
  }
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(w), height: even(h) };
}

function drawOverlay(ctx, lines, w, h) {
  if (!lines || !lines.length) return;
  const size = Math.max(12, Math.round(h / 32));
  ctx.font = `${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(2, size / 6);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#fff';
  lines.forEach((text, i) => {
    const y = size * 0.5 + i * size * 1.25;
    ctx.strokeText(text, size * 0.5, y);
    ctx.fillText(text, size * 0.5, y);
  });
}

/**
 * Erzeugt ein Video aus einem Stack.
 * @param {object} o
 * @param {import('../viewer/loader.js').Stack} o.stack
 * @param {{wc:number, ww:number, invert:boolean}|((frame, info)=>{wc:number, ww:number, invert:boolean})} o.display
 * @param {number} o.fps
 * @param {number} [o.from] erster Frame (0-basiert)
 * @param {number} [o.to] letzter Frame (inklusive)
 * @param {number} [o.repeat] Anzahl Wiederholungen der Sequenz
 * @param {boolean} [o.bounce] vorwärts und rückwärts
 * @param {number} [o.maxSize] maximale Kantenlänge
 * @param {number} [o.scale]
 * @param {keyof QUALITY} [o.quality]
 * @param {'mp4'|'webm'} [o.format]
 * @param {(frameIndex:number)=>string[]} [o.overlay] Textzeilen pro Frame
 * @param {(p:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{blob: Blob, extension: string, codec: string}>}
 */
export async function exportStackVideo(o) {
  const from = o.from ?? 0;
  const to = o.to ?? o.stack.frameCount - 1;
  let sequence = [];
  for (let i = from; i <= to; i++) sequence.push(i);
  if (o.bounce && sequence.length > 2) sequence = sequence.concat(sequence.slice(1, -1).reverse());
  const repeat = Math.max(1, o.repeat || 1);
  const order = [];
  for (let r = 0; r < repeat; r++) order.push(...sequence);

  const first = await o.stack.getFrame(from);
  const size = outputSize(first.width, first.height, { maxSize: o.maxSize, scale: o.scale || 1 });
  const fps = Math.max(1, Math.min(240, o.fps || 15));
  const format = o.format || (supportsMp4() ? 'mp4' : 'webm');

  const out = document.createElement('canvas');
  out.width = size.width;
  out.height = size.height;
  const ctx = out.getContext('2d', { alpha: false, willReadFrequently: false });
  const src = document.createElement('canvas');

  const renderIndex = async (i) => {
    const frame = await o.stack.getFrame(i);
    const info = o.stack.infoFor(i);
    const display = typeof o.display === 'function' ? o.display(frame, info) : o.display;
    frameToCanvas(frame, info, display, src);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Seitenverhältnis erhalten (Rundung auf gerade Pixel kann minimal abweichen)
    const k = Math.min(size.width / frame.width, size.height / frame.height);
    const w = frame.width * k;
    const h = frame.height * k;
    ctx.drawImage(src, (size.width - w) / 2, (size.height - h) / 2, w, h);
    drawOverlay(ctx, o.overlay?.(i), size.width, size.height);
  };

  const bitrate = Math.round(size.width * size.height * fps * QUALITY[o.quality || 'high'].bpp);
  if (format === 'mp4') {
    return encodeMp4({ order, renderIndex, out, size, fps, bitrate, onProgress: o.onProgress, signal: o.signal });
  }
  return encodeWebm({ order, renderIndex, out, fps, bitrate, onProgress: o.onProgress, signal: o.signal });
}

async function encodeMp4({ order, renderIndex, out, size, fps, bitrate, onProgress, signal }) {
  const config = await pickAvcConfig(size.width, size.height, fps, bitrate);
  if (!config) throw new Error(`Der Browser kann kein H.264-Video in ${size.width}×${size.height} erzeugen. Bitte kleinere Größe oder WebM wählen.`);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: size.width, height: size.height, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });
  encoder.configure(config);
  const frameDuration = 1e6 / fps;
  const gop = Math.max(1, Math.round(fps * 2));
  try {
    for (let n = 0; n < order.length; n++) {
      if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
      if (encoderError) throw encoderError;
      await renderIndex(order[n]);
      const vf = new VideoFrame(out, { timestamp: Math.round(n * frameDuration), duration: Math.round(frameDuration) });
      encoder.encode(vf, { keyFrame: n % gop === 0 });
      vf.close();
      // Backpressure: Encoder-Warteschlange nicht überlaufen lassen
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
      onProgress?.((n + 1) / order.length);
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), extension: 'mp4', codec: config.codec };
}

async function encodeWebm({ order, renderIndex, out, fps, bitrate, onProgress, signal }) {
  if (!supportsWebm()) throw new Error('Dieser Browser unterstützt keinen Video-Export.');
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  const stream = out.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => { rec.onstop = r; });
  await renderIndex(order[0]);
  rec.start();
  // MediaRecorder nimmt in Echtzeit auf → Frames im Takt der Bildrate liefern
  const start = performance.now();
  for (let n = 0; n < order.length; n++) {
    if (signal?.aborted) { rec.stop(); throw new DOMException('Abgebrochen', 'AbortError'); }
    await renderIndex(order[n]);
    track.requestFrame?.();
    const due = start + ((n + 1) * 1000) / fps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    onProgress?.((n + 1) / order.length);
  }
  rec.stop();
  await stopped;
  track.stop();
  const type = mime.startsWith('video/mp4') ? 'video/mp4' : 'video/webm';
  return { blob: new Blob(chunks, { type }), extension: type === 'video/mp4' ? 'mp4' : 'webm', codec: mime };
}

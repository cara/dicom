// Umsetzung dekodierter Pixel in darstellbare RGBA-Daten (Modality LUT → VOI/Fensterung → Invertierung).

const MAX_LUT_SIZE = 1 << 21;

/**
 * Standard-Fensterung aus den DICOM-Angaben oder dem Wertebereich.
 * @returns {{wc:number, ww:number}}
 */
export function defaultWindow(info, frame) {
  if (frame && frame.color) return { wc: 127.5, ww: 256 };
  if (info.windowCenter.length && info.windowWidth.length && info.windowWidth[0] > 0) {
    return { wc: info.windowCenter[0], ww: info.windowWidth[0] };
  }
  return autoWindow(info, frame);
}

/** Fenster über den gesamten Wertebereich des Frames. */
export function autoWindow(info, frame) {
  if (!frame || frame.color) return { wc: 127.5, ww: 256 };
  const a = frame.min * info.rescaleSlope + info.rescaleIntercept;
  const b = frame.max * info.rescaleSlope + info.rescaleIntercept;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { wc: (lo + hi + 1) / 2, ww: Math.max(1, hi - lo + 1) };
}

function voi(x, wc, ww, fn) {
  if (fn === 'SIGMOID') return 255 / (1 + Math.exp((-4 * (x - wc)) / ww));
  if (fn === 'LINEAR_EXACT') {
    if (x <= wc - ww / 2) return 0;
    if (x > wc + ww / 2) return 255;
    return ((x - wc) / ww + 0.5) * 255;
  }
  // LINEAR nach PS3.3 C.11.2.1.2
  if (ww <= 1) return x < wc - 0.5 ? 0 : 255;
  if (x <= wc - 0.5 - (ww - 1) / 2) return 0;
  if (x > wc - 0.5 + (ww - 1) / 2) return 255;
  return ((x - (wc - 0.5)) / (ww - 1) + 0.5) * 255;
}

/** Ob die Darstellung (unter Berücksichtigung von MONOCHROME1) invertiert werden muss. */
export function effectiveInvert(info, display) {
  return (info.photometric === 'MONOCHROME1') !== !!display.invert;
}

let lutCache = { key: '', lut: null };

function grayLut(info, frame, display) {
  const { min, max } = frame;
  const size = max - min + 1;
  if (!Number.isInteger(min) || size > MAX_LUT_SIZE) return null;
  const inv = effectiveInvert(info, display);
  const key = `${min}|${max}|${display.wc}|${display.ww}|${inv}|${info.rescaleSlope}|${info.rescaleIntercept}|${info.voiLutFunction}`;
  if (lutCache.key === key) return lutCache.lut;
  const lut = new Uint8ClampedArray(size);
  const { rescaleSlope: m, rescaleIntercept: b, voiLutFunction: fn } = info;
  for (let i = 0; i < size; i++) {
    const v = voi((min + i) * m + b, display.wc, display.ww, fn);
    lut[i] = inv ? 255 - v : v;
  }
  lutCache = { key, lut };
  return lut;
}

/**
 * Schreibt den Frame in ein ImageData-Objekt passender Größe.
 * @param {{width:number,height:number,color:boolean,data:ArrayLike<number>,min?:number,max?:number}} frame
 * @param {{wc:number, ww:number, invert:boolean}} display
 * @param {ImageData} imageData
 */
export function renderFrame(frame, info, display, imageData) {
  const out32 = new Uint32Array(imageData.data.buffer);
  const n = frame.width * frame.height;
  const src = frame.data;
  if (frame.color) {
    const inv = !!display.invert;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const v = voi(i, display.wc, display.ww, 'LINEAR');
      lut[i] = inv ? 255 - v : v;
    }
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      out32[i] = 0xff000000 | (lut[src[j + 2]] << 16) | (lut[src[j + 1]] << 8) | lut[src[j]];
    }
    return imageData;
  }
  const lut = grayLut(info, frame, display);
  if (lut) {
    const min = frame.min;
    for (let i = 0; i < n; i++) {
      const g = lut[src[i] - min];
      out32[i] = 0xff000000 | (g << 16) | (g << 8) | g;
    }
  } else {
    const inv = effectiveInvert(info, display);
    const { rescaleSlope: m, rescaleIntercept: b, voiLutFunction: fn } = info;
    for (let i = 0; i < n; i++) {
      let g = voi(src[i] * m + b, display.wc, display.ww, fn) | 0;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      if (inv) g = 255 - g;
      out32[i] = 0xff000000 | (g << 16) | (g << 8) | g;
    }
  }
  return imageData;
}

/** Rendert den Frame in ein (wiederverwendbares) Canvas in Originalauflösung. */
export function frameToCanvas(frame, info, display, canvas) {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  const ctx = canvas.getContext('2d');
  let img = canvas.__imageData;
  if (!img || img.width !== frame.width || img.height !== frame.height) {
    img = canvas.__imageData = ctx.createImageData(frame.width, frame.height);
  }
  renderFrame(frame, info, display, img);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

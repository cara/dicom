// Synthetische Demo-Daten (keine Patientendaten): eine "Koronarangiographie" und ein "Echo"-Loop.
import { writeDicom, makeUid } from './dicom/writer.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function common(studyUid, seriesUid, modality, desc, seriesNumber) {
  return [
    [0x0008, 0x0018, 'UI', makeUid()],
    [0x0008, 0x0020, 'DA', '20260101'],
    [0x0008, 0x0030, 'TM', '093000'],
    [0x0008, 0x0060, 'CS', modality],
    [0x0008, 0x0070, 'LO', 'Synthetisch'],
    [0x0008, 0x0080, 'LO', 'Demo-Klinik'],
    [0x0008, 0x1030, 'LO', 'Demo-Untersuchung'],
    [0x0008, 0x103e, 'LO', desc],
    [0x0010, 0x0010, 'PN', 'Demo^Patient'],
    [0x0010, 0x0020, 'LO', 'DEMO-0001'],
    [0x0020, 0x000d, 'UI', studyUid],
    [0x0020, 0x000e, 'UI', seriesUid],
    [0x0020, 0x0011, 'IS', String(seriesNumber)],
    [0x0020, 0x0013, 'IS', '1'],
  ];
}

/** Gefäßbaum als Liste von Polylinien (normierte Koordinaten). */
function vesselTree(rand) {
  const branches = [];
  const grow = (x, y, angle, width, depth) => {
    const pts = [[x, y]];
    const len = 0.1 + rand() * 0.12;
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      angle += (rand() - 0.5) * 0.35;
      x += (Math.cos(angle) * len) / steps;
      y += (Math.sin(angle) * len) / steps;
      pts.push([x, y]);
    }
    branches.push({ pts, width, depth });
    if (depth < 4) {
      grow(x, y, angle - 0.3 - rand() * 0.4, width * 0.72, depth + 1);
      if (rand() > 0.25) grow(x, y, angle + 0.3 + rand() * 0.4, width * 0.68, depth + 1);
    }
  };
  grow(0.3, 0.18, 0.9, 0.022, 0);
  grow(0.34, 0.2, 0.15, 0.018, 1);
  return branches;
}

function angioFrames(n, size) {
  const rand = rng(42);
  const tree = vesselTree(rand);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const noise = new Float32Array(size * size).map(() => rand());
  const frames = [];
  for (let f = 0; f < n; f++) {
    const t = f / n;
    // Kontrastmittel: Anfluten → Plateau → Auswaschen
    const fill = Math.min(1, t * 3);
    const opacity = t < 0.65 ? 1 : Math.max(0.15, 1 - (t - 0.65) * 2.5);
    const beat = Math.sin(t * Math.PI * 2 * 4); // vier Herzzyklen
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.75);
    bg.addColorStop(0, '#c8c8c8');
    bg.addColorStop(1, '#5a5a5a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
    // Wirbelsäule/Zwerchfell als weiche Schatten
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(size * 0.62, 0, size * 0.12, size);
    ctx.beginPath();
    ctx.ellipse(size * 0.5, size * 1.05, size * 0.6, size * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    // Katheter
    ctx.strokeStyle = 'rgba(20,20,20,0.9)';
    ctx.lineWidth = size * 0.008;
    ctx.beginPath();
    ctx.moveTo(size * 0.8, size);
    ctx.quadraticCurveTo(size * 0.55, size * 0.4, size * 0.3, size * 0.18);
    ctx.stroke();
    // Gefäße
    ctx.save();
    ctx.translate(size * 0.5, size * 0.5);
    ctx.scale(1 + beat * 0.03, 1 - beat * 0.025);
    ctx.rotate(beat * 0.02);
    ctx.translate(-size * 0.5, -size * 0.5);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of tree) {
      const visible = Math.max(0, Math.min(1, fill * 5 - b.depth));
      if (visible <= 0) continue;
      const count = Math.max(2, Math.round(b.pts.length * visible));
      ctx.strokeStyle = `rgba(15,15,15,${0.85 * opacity})`;
      ctx.lineWidth = b.width * size;
      ctx.beginPath();
      b.pts.slice(0, count).forEach(([x, y], i) => (i ? ctx.lineTo(x * size, y * size) : ctx.moveTo(x * size, y * size)));
      ctx.stroke();
    }
    ctx.restore();
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const gray = new Uint8Array(size * size);
    for (let i = 0; i < gray.length; i++) {
      const v = rgba[i * 4] + (noise[(i + f * 7919) % noise.length] - 0.5) * 18;
      gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    frames.push(gray);
  }
  return frames;
}

function echoFrames(n, w, h) {
  const rand = rng(7);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const speckle = document.createElement('canvas');
  speckle.width = w;
  speckle.height = h;
  const sctx = speckle.getContext('2d');
  const sd = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.pow(rand(), 3) * 255;
    sd.data.set([v, v, v, 255], i * 4);
  }
  sctx.putImageData(sd, 0, 0);
  const frames = [];
  const apexX = w / 2;
  const apexY = h * 0.08;
  const radius = h * 0.85;
  for (let f = 0; f < n; f++) {
    const phase = (f / n) * Math.PI * 2 * 2;
    const contraction = (1 - Math.cos(phase)) / 2; // 0 = Diastole, 1 = Systole
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(apexX, apexY);
    ctx.arc(apexX, apexY, radius, Math.PI / 2 - 0.62, Math.PI / 2 + 0.62);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = 0.55;
    ctx.drawImage(speckle, 0, 0);
    ctx.globalAlpha = 1;
    // Myokard (hell) und Kavum (dunkel)
    const cx = apexX;
    const cy = h * 0.5;
    const rx = w * (0.1 - contraction * 0.03);
    const ry = h * (0.3 - contraction * 0.04);
    ctx.fillStyle = 'rgba(210,205,195,0.75)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + w * 0.035 + contraction * w * 0.01, ry + h * 0.04, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(5,5,5,0.92)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // Farb-Doppler-Jet in der Systole
    if (contraction > 0.4) {
      const g = ctx.createLinearGradient(cx, cy + ry, cx, cy - ry * 0.3);
      g.addColorStop(0, 'rgba(255,60,30,0.9)');
      g.addColorStop(1, 'rgba(255,220,60,0.2)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy + ry * 0.35, rx * 0.35 * contraction, ry * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // EKG-Linie am unteren Rand
    ctx.strokeStyle = '#3f3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const p = ((x / w) * 4 + 0.75) % 1;
      const y = h - 30 - (p > 0.47 && p < 0.5 ? (p - 0.47) * 900 : p >= 0.5 && p < 0.53 ? (0.53 - p) * 900 : 0);
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#ff0';
    ctx.fillRect(((f / n) * 2 % 1) * w, h - 50, 2, 40);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = rgba[i * 4];
      rgb[i * 3 + 1] = rgba[i * 4 + 1];
      rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    frames.push(rgb);
  }
  return frames;
}

function concat(frames) {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}

/** Erzeugt Demo-Dateien als File-Objekte. */
export function createDemoFiles() {
  const study = makeUid();
  const files = [];

  const nA = 45;
  const size = 512;
  const angio = writeDicom([
    ...common(study, makeUid(), 'XA', 'Koronarangiographie LCA (synthetisch)', 1),
    [0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.12.1'],
    [0x0018, 0x1063, 'DS', '66.667'],
    [0x0018, 0x1510, 'DS', '-30'],
    [0x0018, 0x1511, 'DS', '20'],
    [0x0028, 0x0002, 'US', 1],
    [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
    [0x0028, 0x0008, 'IS', String(nA)],
    [0x0028, 0x0010, 'US', size],
    [0x0028, 0x0011, 'US', size],
    [0x0028, 0x0100, 'US', 8],
    [0x0028, 0x0101, 'US', 8],
    [0x0028, 0x0102, 'US', 7],
    [0x0028, 0x0103, 'US', 0],
    [0x0028, 0x1050, 'DS', '128'],
    [0x0028, 0x1051, 'DS', '256'],
  ], { pixelData: concat(angioFrames(nA, size)) });
  files.push({ file: new File([angio], 'XA_LCA_RAO30_CRAN20.dcm'), path: 'Demo/XA_LCA_RAO30_CRAN20.dcm' });

  const nU = 40;
  const w = 480;
  const h = 360;
  const echo = writeDicom([
    ...common(study, makeUid(), 'US', 'TTE apikaler 4KB (synthetisch)', 2),
    [0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.3.1'],
    [0x0018, 0x1063, 'DS', '33.333'],
    [0x0018, 0x1088, 'IS', '72'],
    [0x0028, 0x0002, 'US', 3],
    [0x0028, 0x0004, 'CS', 'RGB'],
    [0x0028, 0x0006, 'US', 0],
    [0x0028, 0x0008, 'IS', String(nU)],
    [0x0028, 0x0010, 'US', h],
    [0x0028, 0x0011, 'US', w],
    [0x0028, 0x0100, 'US', 8],
    [0x0028, 0x0101, 'US', 8],
    [0x0028, 0x0102, 'US', 7],
    [0x0028, 0x0103, 'US', 0],
  ], { pixelData: concat(echoFrames(nU, w, h)) });
  files.push({ file: new File([echo], 'US_TTE_4KB.dcm'), path: 'Demo/US_TTE_4KB.dcm' });
  return files;
}

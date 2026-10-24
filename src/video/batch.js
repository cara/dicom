// Stapel-Export: mehrere Stacks nacheinander als Video in einen Ordner oder ein ZIP schreiben.
import { zipSync } from 'fflate';

export function canPickDirectory() {
  return typeof window.showDirectoryPicker === 'function';
}

function sanitize(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

/**
 * Dateiname für einen Stack.
 * @param {'anon'|'patient'|'source'} pattern
 */
export function videoFileName(stack, pattern, position) {
  const i = stack.info;
  if (pattern === 'source') {
    const base = stack.entries[0].path.split('/').pop().replace(/\.(dcm|dicom)$/i, '');
    return sanitize(base) || `video_${position}`;
  }
  const parts = [];
  if (pattern === 'patient' && i.patientName) parts.push(sanitize(i.patientName));
  if (i.studyDate) parts.push(i.studyDate);
  parts.push(String(position).padStart(3, '0'));
  if (Number.isFinite(i.seriesNumber)) parts.push(`S${i.seriesNumber}`);
  if (stack.isMultiFrame && Number.isFinite(i.instanceNumber)) parts.push(`I${i.instanceNumber}`);
  const desc = sanitize(i.seriesDescription || i.protocolName || i.modality);
  if (desc) parts.push(desc);
  return parts.join('_');
}

/** Ausgabeziel, in das Dateien geschrieben werden. */
export async function openOutput(kind, sourceDirHandle) {
  if (kind === 'zip') {
    const files = {};
    return {
      label: 'ZIP-Archiv',
      async write(name, blob) { files[name] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]; },
      async close() {
        if (!Object.keys(files).length) return;
        const data = zipSync(files);
        download(new Blob([data], { type: 'application/zip' }), `DICOM-Videos_${new Date().toISOString().slice(0, 10)}.zip`);
      },
    };
  }
  if (kind === 'downloads') {
    return {
      label: 'Downloads',
      async write(name, blob) { download(blob, name); await new Promise((r) => setTimeout(r, 400)); },
      async close() {},
    };
  }
  let dir;
  if (kind === 'source') {
    if (!sourceDirHandle) throw new Error('Kein Quellordner mit Schreibzugriff verfügbar');
    if (sourceDirHandle.requestPermission) {
      const perm = await sourceDirHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('Schreibzugriff auf den Quellordner wurde nicht erlaubt');
    }
    dir = await sourceDirHandle.getDirectoryHandle('Videos', { create: true });
  } else {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'dicom-video-export' });
  }
  return {
    label: dir.name,
    async write(name, blob) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    },
    async close() {},
  };
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Eindeutige Namen sicherstellen. */
export function uniqueNamer() {
  const used = new Set();
  return (base, ext) => {
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
}

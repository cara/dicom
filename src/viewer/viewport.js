// Darstellungsfläche mit Zoom/Pan/Fensterung per Maus, Trackpad und Touch.
import { frameToCanvas } from './render.js';

export const TOOLS = ['wl', 'pan', 'zoom', 'scroll'];

export class Viewport {
  /**
   * @param {HTMLElement} container
   * @param {{onWindow?:Function, onScroll?:Function, onChange?:Function}} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.cb = callbacks;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewport-canvas';
    this.canvas.setAttribute('aria-label', 'DICOM-Bild');
    container.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.image = document.createElement('canvas');
    this.tool = 'wl';
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.frame = null;
    this.wheelAccum = 0;
    this.pointers = new Map();
    this.smoothing = true;
    this.bind();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    c.addEventListener('dblclick', () => this.resetView());
    c.style.touchAction = 'none';
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.container.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.container.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.draw();
    }
  }

  /** Neuen Frame anzeigen (bereits dekodiert). */
  show(frame, info, display) {
    this.frame = frame;
    frameToCanvas(frame, info, display, this.image);
    this.draw();
  }

  clear() {
    this.frame = null;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Skalierung, bei der das Bild in den Viewport passt. */
  fitScale() {
    if (!this.frame) return 1;
    return Math.min(this.canvas.width / this.frame.width, this.canvas.height / this.frame.height);
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.frame) return;
    const s = this.fitScale() * this.zoom;
    const dpr = window.devicePixelRatio || 1;
    const w = this.frame.width * s;
    const h = this.frame.height * s;
    const x = (canvas.width - w) / 2 + this.panX * dpr;
    const y = (canvas.height - h) / 2 + this.panY * dpr;
    ctx.imageSmoothingEnabled = this.smoothing && s < 4;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, x, y, w, h);
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.draw();
    this.cb.onChange?.();
  }

  setZoom(zoom, cx, cy) {
    const z = Math.min(40, Math.max(0.1, zoom));
    if (cx !== undefined) {
      // Zoom um den Cursor: Punkt unter dem Cursor bleibt stehen
      const rect = this.canvas.getBoundingClientRect();
      const dx = cx - rect.left - rect.width / 2 - this.panX;
      const dy = cy - rect.top - rect.height / 2 - this.panY;
      const k = z / this.zoom;
      this.panX -= dx * (k - 1);
      this.panY -= dy * (k - 1);
    }
    this.zoom = z;
    this.draw();
    this.cb.onChange?.();
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad-Pinch (ctrlKey) oder Strg/Cmd + Mausrad → Zoom
      this.setZoom(this.zoom * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)), e.clientX, e.clientY);
      return;
    }
    // Blättern durch die Frames
    const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (Math.abs(delta) >= 50) {
      // Mausrad-Raste: ein Bild pro Raste
      this.wheelAccum = 0;
      this.cb.onScroll?.(Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 120)));
      return;
    }
    // Trackpad: viele kleine Deltas → akkumulieren
    this.wheelAccum += delta;
    const step = 24;
    if (Math.abs(this.wheelAccum) >= step) {
      const n = Math.trunc(this.wheelAccum / step);
      this.wheelAccum -= n * step;
      this.cb.onScroll?.(n);
    }
  }

  toolForButton(e) {
    if (e.pointerType === 'mouse') {
      if (e.button === 1) return 'pan';
      if (e.button === 2) return 'zoom';
      if (e.shiftKey) return 'pan';
      if (e.altKey) return 'scroll';
    }
    return this.tool;
  }

  onPointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.pinch = this.pinchState();
      this.drag = null;
      return;
    }
    this.drag = { tool: this.toolForButton(e), x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, scrollAccum: 0 };
    this.canvas.classList.add('dragging');
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom: this.zoom, panX: this.panX, panY: this.panY };
  }

  onPointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const now = this.pinchState();
      this.panX = this.pinch.panX + (now.cx - this.pinch.cx);
      this.panY = this.pinch.panY + (now.cy - this.pinch.cy);
      this.zoom = this.pinch.zoom;
      this.setZoom(this.pinch.zoom * (now.dist / this.pinch.dist), now.cx, now.cy);
      return;
    }
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    switch (d.tool) {
      case 'pan':
        this.panX += dx;
        this.panY += dy;
        this.draw();
        this.cb.onChange?.();
        break;
      case 'zoom':
        this.setZoom(this.zoom * Math.exp(-dy * 0.01), d.startX, d.startY);
        break;
      case 'scroll': {
        d.scrollAccum += dy;
        const step = 8;
        if (Math.abs(d.scrollAccum) >= step) {
          const n = Math.trunc(d.scrollAccum / step);
          d.scrollAccum -= n * step;
          this.cb.onScroll?.(n);
        }
        break;
      }
      default:
        // Horizontal = Fensterbreite, vertikal = Fensterzentrum
        this.cb.onWindow?.(dx, dy);
    }
  }

  onPointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.drag = null;
      this.canvas.classList.remove('dragging');
    }
  }
}

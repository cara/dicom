# DICOM Cine Viewer

Browserbasierter DICOM-Viewer zum **Durchblättern** von DICOM-Bildern und zum **Erzeugen von Videos (MP4/H.264)** aus Cine-Loops – einzeln oder für einen ganzen Ordner. Gedacht für Angiographie-, Echo- und andere Multiframe-Aufnahmen, funktioniert aber auch mit CT/MR-Stapeln.

**Alle Daten werden ausschließlich lokal im Browser verarbeitet. Es findet kein Upload statt.**

- Online: https://cara.github.io/dicom/ (nach Aktivierung von GitHub Pages, siehe unten)
- Offline: eine einzige HTML-Datei (`dicom-viewer.html`) – per Doppelklick öffnen, kein Internet nötig

> ⚠️ Kein Medizinprodukt. Nicht für die diagnostische Befundung bestimmt.

## Funktionen

- **Ordner öffnen** (inkl. Unterordner, z. B. DICOM-CD mit `DICOMDIR`), einzelne Dateien wählen oder per Drag & Drop ablegen
- Automatische Gruppierung nach **Patient → Studie → Serie**; Multiframe-Dateien (Angio-Runs, Echo-Loops) sind je ein eigener Eintrag, Einzelbilder werden nach Serie und Instance Number gestapelt
- **Blättern** mit Mausrad / Trackpad, Pfeiltasten, Schieberegler oder Ziehen
- **Cine-Wiedergabe** mit der Bildrate aus den DICOM-Daten (Frame Time, Cine Rate, Recommended Display Frame Rate, Frame Time Vector), einstellbar; Schleife, Hin & zurück, Einmal
- **Fensterung** (W/L) per Maus, DICOM-Fenster, Auto (Min–Max), CT-Voreinstellungen, Invertierung; Zoom & Pan
- Overlay mit Bildnummer, Fensterung, C-Bogen-Angulation (**RAO/LAO, CRAN/CAUD**), Herzfrequenz u. a.
- **Video-Export** der aktuellen Serie: Bildrate, Bereich, Wiederholungen, Hin & zurück, Größe, Qualität, optional Beschriftung
- **Stapel-Export**: mehrere/alle Serien eines Ordners als Videos – direkt in einen Unterordner `Videos` des Quellordners (Chrome/Edge), in einen frei wählbaren Ordner oder als ZIP
- Einzelbild als PNG speichern, DICOM-Tag-Ansicht mit Filter, Anonym-Modus (blendet Patientendaten aus)

### Unterstützte Formate (Transfer Syntaxes)

| Format | Hinweis |
|---|---|
| Implicit/Explicit VR Little Endian, Explicit VR Big Endian, Deflated | unkomprimiert |
| RLE Lossless | |
| JPEG Baseline (8 Bit) | z. B. Echo (YBR_FULL_422), Dekodierung durch den Browser |
| JPEG Lossless (Process 14, SV1) | typisch für Angiographie |
| JPEG-LS (lossless/near-lossless) | WebAssembly (CharLS) |
| JPEG 2000 / HTJ2K | WebAssembly (OpenJPEG) |
| MPEG-4 AVC/H.264, HEVC | Video-DICOM, Dekodierung über WebCodecs (falls vom Browser unterstützt); alternativ „Videostream extrahieren“ |

Farbräume: MONOCHROME1/2, RGB, YBR_FULL, YBR_FULL_422, PALETTE COLOR; 8/12/16-Bit, signed/unsigned.
Nicht unterstützt: JPEG Extended mit 12 Bit, MPEG-2 (nur Extraktion).

## Bedienung

| Aktion | Maus / Trackpad | Taste |
|---|---|---|
| Blättern | Mausrad, 2-Finger-Wischen, Alt + Ziehen | `←` `→`, `Bild↑` `Bild↓`, `Pos1` `Ende` |
| Wiedergabe | ▶ | `Leertaste`, Bildrate `+` `−` |
| Serie wechseln | Klick in der Liste | `↑` `↓` |
| Fensterung | linke Maustaste ziehen (Werkzeug „Fenster“) | `M` Auto, `I` invertieren, `R` zurücksetzen |
| Verschieben / Zoom | mittlere Taste bzw. Shift / rechte Taste, Strg/⌘ + Mausrad, Pinch | `P` / `Z` |
| Export | „Video“ / „Alle als Video“ | `E` / `B` |
| Sonstiges | | `T` Tags, `A` anonym, `F` Vollbild, `?` Hilfe |

### Hinweise zum Video-Export

- **MP4 (H.264)** wird über WebCodecs erzeugt (Chrome, Edge, Safari ≥ 16.4, Firefox ≥ 130) – schneller als Echtzeit, bildgenau, kompatibel zu PowerPoint/Keynote.
- Ist WebCodecs nicht verfügbar, wird **WebM** über MediaRecorder in Echtzeit aufgenommen.
- Die Videos verwenden die aktuelle Fensterung (Einzel-Export) bzw. das DICOM-Standardfenster (Stapel-Export).
- Dateinamen standardmäßig **ohne Patientennamen** (`Datum_Nr_Serie_Beschreibung.mp4`).

## Lokal betreiben

**Variante 1 – einzelne HTML-Datei (empfohlen):** Auf der Webseite oben rechts „Offline“ klicken oder `dicom-viewer-offline.zip` aus den [Releases](../../releases) laden, entpacken und `dicom-viewer.html` per Doppelklick öffnen.

**Variante 2 – Docker / Portainer:**

```bash
docker compose up -d --build   # → http://localhost:8080
```

In Portainer: *Stacks → Add stack → Repository*, dieses Repository und `docker-compose.yml` angeben.

**Variante 3 – Node.js:**

```bash
npm ci
npm run build
npm run serve            # → http://localhost:8080
```

## GitHub Pages

Der Workflow `.github/workflows/deploy.yml` testet und baut bei jedem Push auf `main` und veröffentlicht `dist/` auf GitHub Pages. Einmalig nötig:

1. *Settings → Pages → Build and deployment → Source:* **GitHub Actions**
2. Auf `main` pushen (oder den Workflow manuell starten)

Ein Tag `v*` (z. B. `git tag v1.0.0 && git push --tags`) erzeugt zusätzlich ein Release mit der Offline-ZIP-Datei.

## Entwicklung

```bash
npm ci
npm run dev     # Watch-Modus + Server auf http://localhost:8080
npm test        # Unit-Tests (node:test)
npm run build   # dist/index.html, dist/dicom-viewer.html, dist/dicom-viewer-offline.zip
```

Aufbau:

```
src/
  main.js              Oberfläche: Laden, Serienliste, Anzeige, Wiedergabe, Export
  index.html           HTML-Gerüst (CSS/JS werden beim Build eingebettet)
  styles.css
  demo.js              synthetische Demo-Daten (Angio + Echo)
  dicom/               Parsen, Frame-Zugriff, Decoder (RLE, JPEG, JPEG-LS, J2K, H.264), Writer
  viewer/              Datei-Import & Gruppierung, Fensterung/LUT, Viewport (Zoom/Pan/W/L)
  video/               MP4/WebM-Export, Stapel-Export (Ordner/ZIP)
scripts/build.mjs      esbuild → eine eigenständige HTML-Datei (WASM eingebettet)
```

Verwendete Bibliotheken: [dicom-parser](https://github.com/cornerstonejs/dicomParser), [jpeg-lossless-decoder-js](https://github.com/rii-mango/JPEGLosslessDecoderJS), [OpenJPEG](https://github.com/uclouvain/openjpeg) & [CharLS](https://github.com/team-charls/charls) (über [cornerstonejs/codecs](https://github.com/cornerstonejs/codecs)), [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), [fflate](https://github.com/101arrowz/fflate) – siehe [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

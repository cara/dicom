/** Planare Anordnung (RRR…GGG…BBB…) in pixelweise verschachtelte (RGBRGB…) umwandeln. */
export function planarToInterleaved(src, spp) {
  const n = src.length / spp;
  const out = new src.constructor(src.length);
  for (let s = 0; s < spp; s++) {
    const base = s * n;
    for (let i = 0; i < n; i++) out[i * spp + s] = src[base + i];
  }
  return out;
}

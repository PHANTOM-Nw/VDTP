// Cell grid -> pixels. Used by the sender's canvas and by the test rasteriser.
//
// The quiet zone is not decoration. The detector rejects any dark region that
// touches the image border, so that a dark background cannot masquerade as the
// frame; without a light margin the frame's own black ring touches the edge and
// the frame becomes undetectable.

export const QUIET_ZONE = 2; // cells of light margin on every side

/** Draw an n x n grid onto a 2D canvas context, centred, with a quiet zone. */
export function drawCells(ctx, cells, n, width, height, { levels = 2, quiet = QUIET_ZONE } = {}) {
  const total = n + 2 * quiet;
  const cell = Math.floor(Math.min(width, height) / total);
  const size = cell * n;
  const ox = ((width - size) / 2) | 0;
  const oy = ((height - size) / 2) | 0;

  // Cell values are levels: 0 darkest, levels-1 lightest. At eight the value is
  // (R<<2)|(G<<1)|B and each bit drives one channel fully on or off — full
  // swing per subpixel, which an LCD also switches faster than a grey step.
  const shade = (v) => {
    if (levels === 8) {
      return `rgb(${(v >> 2) & 1 ? 255 : 0},${(v >> 1) & 1 ? 255 : 0},${v & 1 ? 255 : 0})`;
    }
    const g = Math.round((v * 255) / (levels - 1));
    return `rgb(${g},${g},${g})`;
  };
  ctx.fillStyle = shade(levels - 1);
  ctx.fillRect(0, 0, width, height);
  for (let v = 0; v < levels - 1; v++) {
    ctx.fillStyle = shade(v);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (cells[r * n + c] === v) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
      }
    }
  }
  return { ox, oy, cell, size };
}

/** value -> RGB triple, matching drawCells. */
export function shadeOf(v, levels) {
  if (levels === 8) {
    return [(v >> 2) & 1 ? 255 : 0, (v >> 1) & 1 ? 255 : 0, v & 1 ? 255 : 0];
  }
  const g = Math.round((v * 255) / (levels - 1));
  return [g, g, g];
}

/** Software rasteriser: cell grid -> grayscale image, for tests and headless use. */
export function rasterize(cells, n, scale, quiet = QUIET_ZONE, levels = 2) {
  const pad = quiet * scale;
  const size = n * scale + 2 * pad;
  const gray = new Uint8Array(size * size).fill(255);
  for (let y = 0; y < n * scale; y++) {
    const r = (y / scale) | 0;
    for (let x = 0; x < n * scale; x++) {
      const c = (x / scale) | 0;
      const [rr, gg, bb] = shadeOf(cells[r * n + c], levels);
      gray[(y + pad) * size + (x + pad)] = (rr * 77 + gg * 150 + bb * 29) >> 8;
    }
  }
  return { gray, size, pad };
}

/** Software rasteriser to RGBA, needed once modulation uses colour. */
export function rasterizeRgba(cells, n, scale, quiet = QUIET_ZONE, levels = 2) {
  const pad = quiet * scale;
  const size = n * scale + 2 * pad;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < n * scale; y++) {
    const r = (y / scale) | 0;
    for (let x = 0; x < n * scale; x++) {
      const c = (x / scale) | 0;
      const [rr, gg, bb] = shadeOf(cells[r * n + c], levels);
      const p = ((y + pad) * size + (x + pad)) * 4;
      rgba[p] = rr; rgba[p + 1] = gg; rgba[p + 2] = bb;
    }
  }
  return { rgba, size, pad };
}

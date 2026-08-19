// Shared test fixtures: deterministic bytes and a camera simulator.

export function rand(n, seed = 1) {
  const o = new Uint8Array(n); let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { s=(s^(s<<13))>>>0; s=(s^(s>>>17))>>>0; s=(s^(s<<5))>>>0; o[i]=s&0xff; }
  return o;
}

export function invert3(m) {
  const [a,b,c,d,e,f,g,h,i] = m;
  const A = (e*i - f*h), B = -(d*i - f*g), C = (d*h - e*g);
  const det = a*A + b*B + c*C;
  if (Math.abs(det) < 1e-12) throw new Error('singular');
  return [
    A/det, (c*h - b*i)/det, (b*f - c*e)/det,
    B/det, (a*i - c*g)/det, (c*d - a*f)/det,
    C/det, (b*g - a*h)/det, (a*e - b*d)/det,
  ];
}

export function matrixFor([[x0,y0],[x1,y1],[x2,y2],[x3,y3]]) {
  const dx1=x1-x2, dx2=x3-x2, sx=x0-x1+x2-x3;
  const dy1=y1-y2, dy2=y3-y2, sy=y0-y1+y2-y3;
  const den=dx1*dy2-dx2*dy1;
  const g=(sx*dy2-dx2*sy)/den, h=(dx1*sy-sx*dy1)/den;
  return [x1-x0+g*x1, x3-x0+h*x3, x0, y1-y0+g*y1, y3-y0+h*y3, y0, g, h, 1];
}

/**
 * Simulate a camera pointed at a screen: place the rendered frame on a
 * background, warp it in perspective, blur it, and add sensor noise.
 */
export function simulateCapture(src, srcSize, {
  out = 720, quad, blur = 1, noise = 0, bg = 210, seed = 99,
  gradient = 0, glare = 0,
} = {}) {
  const Hinv = invert3(matrixFor(quad));
  const img = new Uint8Array(out * out).fill(bg);

  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w = Hinv[6]*px + Hinv[7]*py + Hinv[8];
      const u = (Hinv[0]*px + Hinv[1]*py + Hinv[2]) / w;
      const v = (Hinv[3]*px + Hinv[4]*py + Hinv[5]) / w;
      if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
      const fx = u * srcSize - 0.5, fy = v * srcSize - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const at = (xx, yy) => src[Math.min(srcSize-1, Math.max(0, yy)) * srcSize + Math.min(srcSize-1, Math.max(0, xx))];
      img[y*out + x] =
        at(x0,y0)*(1-tx)*(1-ty) + at(x0+1,y0)*tx*(1-ty) +
        at(x0,y0+1)*(1-tx)*ty   + at(x0+1,y0+1)*tx*ty;
    }
  }

  for (let pass = 0; pass < blur; pass++) {
    const copy = Uint8Array.from(img);
    for (let y = 1; y < out-1; y++) {
      for (let x = 1; x < out-1; x++) {
        let acc = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) acc += copy[(y+dy)*out + x+dx];
        img[y*out + x] = acc / 9;
      }
    }
  }

  // An LCD shot off-axis loses brightness across the panel, and a lamp or
  // window puts a bright patch on the glass. Both tilt the black/white balance
  // across the frame, which is exactly what a single global cut cannot follow.
  if (gradient > 0 || glare > 0) {
    const cx = out * 0.32, cy = out * 0.3, radius = out * 0.35;
    for (let y = 0; y < out; y++) {
      for (let x = 0; x < out; x++) {
        let v = img[y * out + x];
        if (gradient > 0) v *= 1 - gradient * ((x / out) * 0.6 + (y / out) * 0.4);
        if (glare > 0) {
          const d = Math.hypot(x - cx, y - cy) / radius;
          if (d < 1) v += glare * (1 - d * d);
        }
        img[y * out + x] = Math.max(0, Math.min(255, v));
      }
    }
  }

  if (noise > 0) {
    const n = rand(out * out, seed);
    for (let i = 0; i < img.length; i++) {
      img[i] = Math.max(0, Math.min(255, img[i] + ((n[i] / 255) - 0.5) * 2 * noise));
    }
  }
  return { gray: img, size: out };
}

/**
 * A camera pointed at a real monitor, not at a floating image: the frame sits
 * on a white page, the page sits inside a dark bezel, and the bezel sits in a
 * room. The bezel is the part that matters — it is a dark ring whose bounding
 * box is larger than the frame's, so any detector that simply takes the biggest
 * dark region locks onto the monitor instead of the payload.
 */
export function simulateMonitorScene(src, srcSize, {
  out = 1080, quad, blur = 1, noise = 10, room = 150, bezel = 20, page = 250, bezelScale = 1.18,
} = {}) {
  const cx = quad.reduce((a, p) => a + p[0], 0) / 4;
  const cy = quad.reduce((a, p) => a + p[1], 0) / 4;
  const grow = (f) => quad.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]);

  const img = new Uint8Array(out * out).fill(room);
  const paintQuad = (q, value) => {
    const Hinv = invert3(matrixFor(q));
    for (let y = 0; y < out; y++) {
      for (let x = 0; x < out; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w = Hinv[6]*px + Hinv[7]*py + Hinv[8];
        const u = (Hinv[0]*px + Hinv[1]*py + Hinv[2]) / w;
        const v = (Hinv[3]*px + Hinv[4]*py + Hinv[5]) / w;
        if (u >= 0 && v >= 0 && u < 1 && v < 1) img[y*out + x] = value;
      }
    }
  };

  paintQuad(grow(bezelScale), bezel);   // monitor housing
  paintQuad(grow(1.06), page);          // the sender window's white background

  const Hinv = invert3(matrixFor(quad));
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w = Hinv[6]*px + Hinv[7]*py + Hinv[8];
      const u = (Hinv[0]*px + Hinv[1]*py + Hinv[2]) / w;
      const v = (Hinv[3]*px + Hinv[4]*py + Hinv[5]) / w;
      if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
      const fx = u * srcSize - 0.5, fy = v * srcSize - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const at = (xx, yy) => src[Math.min(srcSize-1, Math.max(0, yy)) * srcSize + Math.min(srcSize-1, Math.max(0, xx))];
      img[y*out + x] =
        at(x0,y0)*(1-tx)*(1-ty) + at(x0+1,y0)*tx*(1-ty) +
        at(x0,y0+1)*(1-tx)*ty   + at(x0+1,y0+1)*tx*ty;
    }
  }

  for (let pass = 0; pass < blur; pass++) {
    const copy = Uint8Array.from(img);
    for (let y = 1; y < out-1; y++) {
      for (let x = 1; x < out-1; x++) {
        let acc = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) acc += copy[(y+dy)*out + x+dx];
        img[y*out + x] = acc / 9;
      }
    }
  }
  if (noise > 0) {
    const n = rand(out * out, 137);
    for (let i = 0; i < img.length; i++) {
      img[i] = Math.max(0, Math.min(255, img[i] + ((n[i] / 255) - 0.5) * 2 * noise));
    }
  }
  return { gray: img, size: out };
}

/**
 * Build one banded matrix: `plan.count` independent frames, one per band.
 *
 * Mirrors what a sender does — pull N frames from the stream and pack them
 * into the bands — so fixtures exercise the real geometry rather than a
 * whole-frame layout the receiver no longer expects.
 */
export async function bandedCells(layout, { sessionTag = 0x77, seedBase = 1, ecc = true } = {}) {
  const { planBands, encodeFrameBands } = await import('../visual/matrix.js');
  const { encodeFrame, FrameType, OVERHEAD } = await import('../core/frame.js');
  const { eccCapacity, ECC_REDUNDANCY } = await import('../core/ecc.js');

  const plan = planBands(layout);
  const payloads = [], frames = [];
  plan.bands.forEach((band, i) => {
    const budget = ecc ? plan.frameBudget : (band.bytes - OVERHEAD);
    const payload = rand(budget, seedBase * 1000 + i);
    payloads.push(payload);
    frames.push(encodeFrame({
      type: FrameType.DATA, sessionTag, frameId: seedBase * 100 + i,
      seed: seedBase * 1000 + i, eccLevel: ecc ? 1 : 0, payload,
    }));
  });
  return { cells: encodeFrameBands(layout, plan, frames, ecc), plan, payloads, frames };
}

/**
 * A camera pointed at a colour frame.
 *
 * Beyond the geometry, two effects that only colour has to survive: red and
 * blue arrive at half green's sampling density through the Bayer filter, and
 * display subpixel bleed plus camera filter overlap mix a share of each
 * channel into the others.
 */
export function simulateColorCapture(rgbaSrc, srcSize, {
  out = 720, quad, blur = 1, chromaBlur = 1, crosstalk = 0.15,
  gain = [1.15, 1.0, 0.9], noise = 10, seed = 99,
} = {}) {
  const mixed = new Uint8ClampedArray(rgbaSrc.length);
  for (let i = 0; i < srcSize * srcSize; i++) {
    const p = i * 4, r = rgbaSrc[p], g = rgbaSrc[p + 1], b = rgbaSrc[p + 2];
    for (let ch = 0; ch < 3; ch++) {
      const own = rgbaSrc[p + ch];
      const others = (r + g + b - own) / 2;
      mixed[p + ch] = ((1 - crosstalk) * own + crosstalk * others) * gain[ch];
    }
    mixed[p + 3] = 255;
  }

  const rgba = new Uint8ClampedArray(out * out * 4).fill(255);
  for (let ch = 0; ch < 3; ch++) {
    const plane = new Uint8Array(srcSize * srcSize);
    for (let i = 0; i < plane.length; i++) plane[i] = mixed[i * 4 + ch];
    // Green keeps full resolution; red and blue get the extra Bayer blur.
    const shot = simulateCapture(plane, srcSize, {
      out, quad, blur: blur + (ch === 1 ? 0 : chromaBlur), noise, bg: 210, seed: seed + ch,
    });
    for (let i = 0; i < out * out; i++) rgba[i * 4 + ch] = shot.gray[i];
  }
  return { rgba, size: out };
}

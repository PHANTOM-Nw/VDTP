#include "vdtp.h"
#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* ---------------- PRNG ---------------- */

uint32_t vdtp_mix32(uint32_t x) {
  x ^= x >> 16;
  x *= 0x21f0aaadu;
  x ^= x >> 15;
  x *= 0x735a2d97u;
  x ^= x >> 15;
  return x;
}

void vdtp_rng_init(vdtp_rng *r, uint32_t seed) {
  r->s = vdtp_mix32(seed);
  if (r->s == 0) r->s = 0x9e3779b9u;
}

uint32_t vdtp_rng_next(vdtp_rng *r) {
  r->s ^= r->s << 13;
  r->s ^= r->s >> 17;
  r->s ^= r->s << 5;
  return r->s;
}

/* ---------------- CRC32 ---------------- */

static uint32_t crc_table[256];
static int crc_ready = 0;

static void crc_init(void) {
  for (int i = 0; i < 256; i++) {
    uint32_t c = (uint32_t)i;
    for (int k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320u ^ (c >> 1)) : (c >> 1);
    crc_table[i] = c;
  }
  crc_ready = 1;
}

uint32_t vdtp_crc32(const uint8_t *data, size_t len) {
  if (!crc_ready) crc_init();
  uint32_t c = 0xffffffffu;
  for (size_t i = 0; i < len; i++) c = crc_table[(c ^ data[i]) & 0xff] ^ (c >> 8);
  return c ^ 0xffffffffu;
}

/* ---------------- SHA-256 ---------------- */

static const uint32_t SHA_K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

void vdtp_sha256(const uint8_t *data, size_t len, uint8_t out[32]) {
  uint32_t h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                   0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  size_t total = ((len + 8) / 64 + 1) * 64;
  uint8_t *buf = (uint8_t *)calloc(total, 1);
  if (!buf) return;
  memcpy(buf, data, len);
  buf[len] = 0x80;
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 0; i < 8; i++) buf[total - 1 - i] = (uint8_t)(bits >> (8 * i));

  uint32_t w[64];
  for (size_t off = 0; off < total; off += 64) {
    for (int i = 0; i < 16; i++) {
      w[i] = ((uint32_t)buf[off+i*4] << 24) | ((uint32_t)buf[off+i*4+1] << 16)
           | ((uint32_t)buf[off+i*4+2] << 8) | (uint32_t)buf[off+i*4+3];
    }
    for (int i = 16; i < 64; i++) {
      uint32_t a = w[i-15], b = w[i-2];
      uint32_t s0 = ROR(a,7) ^ ROR(a,18) ^ (a >> 3);
      uint32_t s1 = ROR(b,17) ^ ROR(b,19) ^ (b >> 10);
      w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = ROR(e,6) ^ ROR(e,11) ^ ROR(e,25);
      uint32_t ch = (e & f) ^ (~e & g);
      uint32_t t1 = hh + S1 + ch + SHA_K[i] + w[i];
      uint32_t S0 = ROR(a,2) ^ ROR(a,13) ^ ROR(a,22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
    }
    h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
  }
  free(buf);
  for (int i = 0; i < 8; i++) {
    out[i*4]   = (uint8_t)(h[i] >> 24); out[i*4+1] = (uint8_t)(h[i] >> 16);
    out[i*4+2] = (uint8_t)(h[i] >> 8);  out[i*4+3] = (uint8_t)h[i];
  }
}

void vdtp_hex(const uint8_t *bytes, size_t len, char *out) {
  static const char *D = "0123456789abcdef";
  for (size_t i = 0; i < len; i++) { out[i*2] = D[bytes[i] >> 4]; out[i*2+1] = D[bytes[i] & 15]; }
  out[len*2] = 0;
}

/* ---------------- robust soliton ---------------- */

#define VDTP_SOLITON_C     0.05
#define VDTP_SOLITON_DELTA 0.05

int vdtp_soliton_init(vdtp_soliton *s, int K) {
  if (K < 1) return -1;
  s->K = K;
  s->cdf  = (uint32_t *)calloc((size_t)K + 1, sizeof(uint32_t));
  s->seen = (uint8_t *)calloc((size_t)K, 1);
  s->idx  = (int *)calloc((size_t)K, sizeof(int));
  if (!s->cdf || !s->seen || !s->idx) { vdtp_soliton_free(s); return -1; }

  if (K == 1) { s->cdf[1] = VDTP_CDF_SCALE; return 0; }

  double R = VDTP_SOLITON_C * log((double)K / VDTP_SOLITON_DELTA) * sqrt((double)K);
  int pivot = (int)floor((double)K / R);
  double *p = (double *)calloc((size_t)K + 1, sizeof(double));
  if (!p) { vdtp_soliton_free(s); return -1; }

  for (int i = 1; i <= K; i++) {
    double rho = (i == 1) ? 1.0 / (double)K : 1.0 / ((double)i * (double)(i - 1));
    double tau = 0.0;
    if (i < pivot)       tau = R / ((double)i * (double)K);
    else if (i == pivot) tau = (R * log(R / VDTP_SOLITON_DELTA)) / (double)K;
    p[i] = rho + tau;
  }

  double beta = 0.0;
  for (int i = 1; i <= K; i++) beta += p[i];

  double acc = 0.0;
  for (int i = 1; i <= K; i++) {
    acc += p[i] / beta;
    double q = floor(acc * (double)VDTP_CDF_SCALE);
    s->cdf[i] = (q > (double)VDTP_CDF_SCALE) ? VDTP_CDF_SCALE : (uint32_t)q;
  }
  s->cdf[K] = VDTP_CDF_SCALE;
  free(p);
  return 0;
}

void vdtp_soliton_free(vdtp_soliton *s) {
  free(s->cdf); free(s->seen); free(s->idx);
  s->cdf = NULL; s->seen = NULL; s->idx = NULL; s->K = 0;
}

int vdtp_neighbours(vdtp_soliton *s, uint32_t seed) {
  vdtp_rng rng;
  vdtp_rng_init(&rng, seed);
  uint32_t u = vdtp_rng_next(&rng) >> 8;

  int lo = 1, hi = s->K;
  while (lo < hi) {
    int mid = (lo + hi) >> 1;
    if (u < s->cdf[mid]) hi = mid; else lo = mid + 1;
  }
  int degree = lo > s->K ? s->K : lo;

  memset(s->seen, 0, (size_t)s->K);
  int count = 0;
  while (count < degree) {
    int i = (int)(vdtp_rng_next(&rng) % (uint32_t)s->K);
    if (!s->seen[i]) { s->seen[i] = 1; s->idx[count++] = i; }
  }
  return degree;
}

/* ---------------- LT encoder ---------------- */

int vdtp_encoder_init(vdtp_encoder *e, const uint8_t *data, size_t len, int block_size) {
  if (block_size < 1) return -1;
  e->data = data;
  e->len = len;
  e->block_size = block_size;
  e->K = (int)((len + (size_t)block_size - 1) / (size_t)block_size);
  if (e->K < 1) e->K = 1;
  return vdtp_soliton_init(&e->soliton, e->K);
}

void vdtp_encoder_free(vdtp_encoder *e) { vdtp_soliton_free(&e->soliton); }

/* XOR source block `i` into out, honouring the zero padding of the last block. */
static void xor_block(vdtp_encoder *e, int i, uint8_t *out) {
  size_t start = (size_t)i * (size_t)e->block_size;
  size_t n = e->len > start ? e->len - start : 0;
  if (n > (size_t)e->block_size) n = (size_t)e->block_size;
  for (size_t j = 0; j < n; j++) out[j] ^= e->data[start + j];
}

/*
 * Every seed is random-degree fountain output. Seeds 1..K used to be a
 * systematic prefix; it cost more than it saved on a lossy channel — see the
 * note on LtEncoder.symbol in core/lt.js.
 */
void vdtp_encoder_symbol(vdtp_encoder *e, uint32_t seed, uint8_t *out) {
  memset(out, 0, (size_t)e->block_size);
  int d = vdtp_neighbours(&e->soliton, seed);
  for (int j = 0; j < d; j++) xor_block(e, e->soliton.idx[j], out);
}

/* ---------------- frame ---------------- */

static void put32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16);
  p[2] = (uint8_t)(v >> 8);  p[3] = (uint8_t)v;
}

size_t vdtp_frame_encode(uint8_t *out, uint8_t type, uint32_t session_tag,
                         uint32_t frame_id, uint32_t seed, uint8_t ecc_level,
                         const uint8_t *payload, size_t payload_len) {
  if (payload_len > 0xffff) return 0;
  put32(out, VDTP_MAGIC);
  out[4] = VDTP_VERSION;
  out[5] = type;
  put32(out + 6, session_tag);
  put32(out + 10, frame_id);
  put32(out + 14, seed);
  out[18] = ecc_level;
  out[19] = (uint8_t)(payload_len >> 8);
  out[20] = (uint8_t)payload_len;
  memcpy(out + VDTP_HEADER_SIZE, payload, payload_len);
  size_t end = VDTP_HEADER_SIZE + payload_len;
  put32(out + end, vdtp_crc32(out, end));
  return end + VDTP_TRAILER_SIZE;
}

/* ---------------- Reed-Solomon over GF(256) ---------------- */

static uint8_t gf_exp[512];
static uint8_t gf_log[256];
static int gf_ready = 0;

static void gf_init(void) {
  int x = 1;
  for (int i = 0; i < 255; i++) {
    gf_exp[i] = (uint8_t)x;
    gf_log[x] = (uint8_t)i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (int i = 255; i < 512; i++) gf_exp[i] = gf_exp[i - 255];
  gf_ready = 1;
}

static uint8_t gf_mul(uint8_t a, uint8_t b) {
  if (a == 0 || b == 0) return 0;
  return gf_exp[gf_log[a] + gf_log[b]];
}

/* Generator polynomial for nsym parity symbols, descending degree. */
static int rs_generator(int nsym, uint8_t *gen) {
  gen[0] = 1;
  int len = 1;
  for (int i = 0; i < nsym; i++) {
    uint8_t root = gf_exp[i % 255];
    /* multiply by (x + root) */
    gen[len] = 0;
    for (int j = len; j > 0; j--) gen[j] ^= gf_mul(gen[j - 1], root);
    len++;
  }
  return len;
}

void vdtp_rs_encode(const uint8_t *data, int k, int nsym, uint8_t *out) {
  if (!gf_ready) gf_init();
  uint8_t gen[256];
  int glen = rs_generator(nsym, gen);

  memcpy(out, data, (size_t)k);
  memset(out + k, 0, (size_t)nsym);
  for (int i = 0; i < k; i++) {
    uint8_t coef = out[i];
    if (coef == 0) continue;
    for (int j = 1; j < glen; j++) out[i + j] ^= gf_mul(gen[j], coef);
  }
  memcpy(out, data, (size_t)k); /* the division above overwrote the prefix */
}

/* ---------------- ECC block plan and interleaving ---------------- */

int vdtp_ecc_plan_init(vdtp_ecc_plan *p, int capacity, double redundancy) {
  memset(p, 0, sizeof(*p));
  if (capacity < 8 || !(redundancy > 0.0 && redundancy < 0.5)) return -1;

  int blocks = (capacity + 254) / 255;
  p->blocks = blocks;
  p->capacity = capacity;
  p->sizes = (int *)calloc((size_t)blocks, sizeof(int));
  p->parity = (int *)calloc((size_t)blocks, sizeof(int));
  if (!p->sizes || !p->parity) { vdtp_ecc_plan_free(p); return -1; }

  int base = capacity / blocks, extra = capacity % blocks;
  for (int i = 0; i < blocks; i++) {
    int total = base + (i < extra ? 1 : 0);
    /* Even parity: RS corrects nsym/2, so an odd symbol buys nothing. */
    int nsym = (int)(floor((double)total * redundancy / 2.0 + 0.5)) * 2;
    if (nsym < 2) nsym = 2;
    if (nsym >= total) nsym = total - 1;
    p->sizes[i] = total;
    p->parity[i] = nsym;
    p->data_bytes += total - nsym;
  }
  return 0;
}

void vdtp_ecc_plan_free(vdtp_ecc_plan *p) {
  free(p->sizes); free(p->parity);
  p->sizes = NULL; p->parity = NULL; p->blocks = 0;
}

int vdtp_ecc_capacity(int capacity, double redundancy) {
  vdtp_ecc_plan p;
  if (vdtp_ecc_plan_init(&p, capacity, redundancy) != 0) return -1;
  int n = p.data_bytes;
  vdtp_ecc_plan_free(&p);
  return n;
}

int vdtp_ecc_encode(const vdtp_ecc_plan *p, const uint8_t *data, size_t len, uint8_t *out) {
  if ((int)len > p->data_bytes) return -1;

  uint8_t **enc = (uint8_t **)calloc((size_t)p->blocks, sizeof(uint8_t *));
  if (!enc) return -1;

  size_t offset = 0;
  for (int i = 0; i < p->blocks; i++) {
    int k = p->sizes[i] - p->parity[i];
    uint8_t chunk[256];
    memset(chunk, 0, (size_t)k);
    size_t take = 0;
    if (offset < len) {
      take = len - offset;
      if (take > (size_t)k) take = (size_t)k;
      memcpy(chunk, data + offset, take);
    }
    offset += (size_t)k;
    enc[i] = (uint8_t *)malloc((size_t)p->sizes[i]);
    if (!enc[i]) { for (int j = 0; j < i; j++) free(enc[j]); free(enc); return -1; }
    vdtp_rs_encode(chunk, k, p->parity[i], enc[i]);
  }

  /* Round-robin interleave: a contiguous run of damaged modules lands one
     symbol at a time in each codeword instead of wiping one out. */
  int w = 0;
  for (int pos = 0;; pos++) {
    int wrote = 0;
    for (int b = 0; b < p->blocks; b++) {
      if (pos < p->sizes[b]) { out[w++] = enc[b][pos]; wrote = 1; }
    }
    if (!wrote) break;
  }

  for (int i = 0; i < p->blocks; i++) free(enc[i]);
  free(enc);
  return 0;
}

/*
 * Deterministic mask applied to payload bytes before they become cells.
 *
 * Without it a frame's content decides its appearance, and sparse content is a
 * terrible optical target: the handshake frame is mostly padding, so 91% of
 * its modules landed on one level, which biases the camera's auto-exposure and
 * breaks multi-level decoding outright. Mirrors maskByte in visual/matrix.js.
 */
static uint8_t mask_byte(size_t index) {
  return (uint8_t)(vdtp_mix32((uint32_t)index) & 0xffu);
}

/*
 * Gray coding for multi-level symbols: adjacent levels differ in exactly one
 * bit, so the misread that actually happens — confusing a level with its
 * neighbour — costs one bit instead of two. Identity at 1 bit per cell.
 * Mirrors toGray in visual/matrix.js.
 */
/*
 * Only grey levels are Gray coded. A colour error is a single channel
 * flipping, and the (R<<2)|(G<<1)|B encoding already costs exactly one bit for
 * that; Gray coding would only scramble it.
 */
static unsigned to_gray(unsigned v) { return v ^ (v >> 1); }
static unsigned map_symbol(const vdtp_layout *l, unsigned v) {
  return l->levels == 4 ? to_gray(v) : v;
}

/* Big-endian bit packing, `width` bits at a time, masked. */
static unsigned read_bits(const uint8_t *bytes, size_t len, int bit, int width) {
  unsigned v = 0;
  for (int i = 0; i < width; i++) {
    int p = bit + i;
    size_t byte = (size_t)(p >> 3);
    unsigned src = byte < len ? (unsigned)(bytes[byte] ^ mask_byte(byte))
                              : (unsigned)mask_byte(byte);
    v = (v << 1) | ((src >> (7 - (p & 7))) & 1u);
  }
  return v;
}

/* ---------------- horizontal bands ---------------- */

static int band_bits(const vdtp_layout *l, int from, int to) {
  int lo = VDTP_BORDER, hi = l->n - VDTP_BORDER - 1, bits = 0;
  for (int r = from; r <= to; r++) {
    for (int c = lo; c <= hi; c++) if (vdtp_structure_at(l, r, c) < 0) bits++;
  }
  return bits;
}

static int band_split(const vdtp_layout *l, int count, vdtp_band *out) {
  int lo = VDTP_BORDER, hi = l->n - VDTP_BORDER - 1, rows = hi - lo + 1;
  if (count < 1 || count > rows) return -1;
  for (int b = 0; b < count; b++) {
    int from = lo + (int)((long)b * rows / count);
    int to = lo + (int)((long)(b + 1) * rows / count) - 1;
    out[b].from = from;
    out[b].to = to;
    /* Cells times bits per cell: a band at four levels or in colour carries
       twice or three times the bytes of the same rows in binary. */
    out[b].bits = band_bits(l, from, to) * l->bits_per_cell;
    out[b].bytes = out[b].bits >> 3;
  }
  return 0;
}

int vdtp_plan_bands(const vdtp_layout *l, double redundancy, vdtp_band_plan *out) {
  int found = 0;
  double best = -1.0;
  for (int count = 1; count <= VDTP_MAX_BANDS; count++) {
    vdtp_band bands[VDTP_MAX_BANDS];
    if (band_split(l, count, bands) != 0) break;

    int payload = 0, frame_budget = INT_MAX, viable = 1;
    for (int b = 0; b < count; b++) {
      int budget = vdtp_ecc_capacity(bands[b].bytes, redundancy) - VDTP_OVERHEAD;
      if (budget < 24) { viable = 0; break; }
      payload += budget;
      if (budget < frame_budget) frame_budget = budget;
    }
    if (!viable) continue;

    double delivered = (double)payload * (1.0 - VDTP_TEAR_RATE / (double)count);
    if (delivered > best) {
      best = delivered;
      out->count = count;
      out->payload = payload;
      out->frame_budget = frame_budget;
      memcpy(out->bands, bands, sizeof(vdtp_band) * (size_t)count);
      found = 1;
    }
  }
  return found ? 0 : -1;
}

int vdtp_encode_bands(const vdtp_layout *l, const vdtp_band_plan *p,
                      const uint8_t *const *buffers, uint8_t *cells) {
  int n = l->n, lo = VDTP_BORDER, hi = n - VDTP_BORDER - 1;
  for (int r = 0; r < n; r++) {
    for (int c = 0; c < n; c++) {
      int st = vdtp_structure_at(l, r, c);
      cells[r * n + c] = (uint8_t)(st >= 0 ? st : 0);
    }
  }
  for (int b = 0; b < p->count; b++) {
    const uint8_t *buf = buffers[b];
    int bytes = p->bands[b].bytes, bit = 0, w = l->bits_per_cell;
    for (int r = p->bands[b].from; r <= p->bands[b].to; r++) {
      for (int c = lo; c <= hi; c++) {
        if (vdtp_structure_at(l, r, c) >= 0) continue;
        cells[r * n + c] = (uint8_t)map_symbol(l, read_bits(buf, (size_t)bytes, bit, w));
        bit += w;
      }
    }
  }
  return 0;
}

/* ---------------- frame stream ---------------- */

int vdtp_stream_init(vdtp_stream *s, const uint8_t *data, size_t len,
                     int frame_capacity, int payload_budget, uint32_t session_tag,
                     const char *meta_json, size_t meta_len, int ecc) {
  memset(s, 0, sizeof(*s));
  s->ecc = ecc;

  int budget = frame_capacity;
  if (ecc) {
    if (vdtp_ecc_plan_init(&s->plan, frame_capacity, VDTP_ECC_REDUNDANCY) != 0) return -1;
    budget = s->plan.data_bytes;
    s->wire = (uint8_t *)malloc((size_t)frame_capacity);
    if (!s->wire) { vdtp_stream_free(s); return -1; }
  }

  s->block_size = payload_budget > 0 ? payload_budget : budget - VDTP_OVERHEAD;
  if (s->block_size < 32) { vdtp_stream_free(s); return -1; }
  if (meta_len + VDTP_OVERHEAD > (size_t)budget) { vdtp_stream_free(s); return -1; }

  s->capacity_bytes = frame_capacity;
  s->session_tag = session_tag;
  s->meta_json = meta_json;
  s->meta_len = meta_len;
  s->meta_interval = VDTP_METADATA_INTERVAL;
  s->seed = 1;

  /* Separate allocations on purpose: carving the symbol scratch out of the
     tail of the frame buffer is what overflowed the heap before. */
  s->frame = (uint8_t *)malloc((size_t)frame_capacity);
  s->payload = (uint8_t *)malloc((size_t)s->block_size);
  if (!s->frame || !s->payload) { vdtp_stream_free(s); return -1; }

  if (vdtp_encoder_init(&s->enc, data, len, s->block_size) != 0) {
    vdtp_stream_free(s);
    return -1;
  }
  return 0;
}

void vdtp_stream_free(vdtp_stream *s) {
  free(s->frame); free(s->payload); free(s->wire);
  s->frame = NULL; s->payload = NULL; s->wire = NULL;
  if (s->plan.blocks) vdtp_ecc_plan_free(&s->plan);
  vdtp_encoder_free(&s->enc);
}

/* Wrap the serialised frame for the wire, if correction is on. */
static size_t stream_wrap(vdtp_stream *s, size_t len) {
  if (!s->ecc) return len;
  if (vdtp_ecc_encode(&s->plan, s->frame, len, s->wire) != 0) return 0;
  memcpy(s->frame, s->wire, (size_t)s->plan.capacity);
  return (size_t)s->plan.capacity;
}

size_t vdtp_stream_metadata(vdtp_stream *s) {
  size_t n = vdtp_frame_encode(s->frame, VDTP_BOOTSTRAP, s->session_tag, s->frame_id++,
                               0, (uint8_t)(s->ecc ? 1 : 0),
                               (const uint8_t *)s->meta_json, s->meta_len);
  return stream_wrap(s, n);
}

/*
 * Restart the *display* sequence, not the fountain.
 *
 * The seed deliberately keeps climbing. A receiver rejects a seed it has
 * already accepted, so replaying seeds a sender has already sent hands it
 * nothing but duplicates and freezes its progress — which is exactly what an
 * operator triggers by stopping and restarting a long transfer that looks
 * stuck. Continuing the fountain instead lets the receiver keep everything it
 * had, which is the whole point of coding this way.
 */
void vdtp_stream_rewind(vdtp_stream *s) {
  s->frame_id = 0;
  s->since_meta = 0;
}

size_t vdtp_stream_data(vdtp_stream *s) {
  vdtp_encoder_symbol(&s->enc, s->seed, s->payload);
  size_t n = vdtp_frame_encode(s->frame, VDTP_DATA, s->session_tag, s->frame_id++,
                               s->seed, (uint8_t)(s->ecc ? 1 : 0),
                               s->payload, (size_t)s->block_size);
  s->seed++;
  return n;
}

size_t vdtp_stream_next(vdtp_stream *s) {
  if (s->since_meta == 0 || s->since_meta > s->meta_interval) {
    s->since_meta = 1;
    return vdtp_stream_metadata(s);
  }
  s->since_meta++;
  return stream_wrap(s, vdtp_stream_data(s));
}

/* ---------------- visual matrix ---------------- */

int vdtp_layout_init(vdtp_layout *l, int n, int levels) {
  if (n < 4 * VDTP_BORDER + 4 * VDTP_ORIENT) return -1;
  if (levels != 2 && levels != 4 && levels != 8) return -1;
  l->n = n;
  l->levels = levels;
  l->bits_per_cell = levels == 2 ? 1 : (levels == 4 ? 2 : 3);
  l->inner = n - 2 * VDTP_BORDER;
  l->cells = l->inner * l->inner - 4 * VDTP_ORIENT * VDTP_ORIENT;
  l->capacity_bits = l->cells * l->bits_per_cell;
  l->capacity_bytes = l->capacity_bits >> 3;
  return 0;
}

static int min4(int a, int b, int c, int d) {
  int m = a < b ? a : b;
  if (c < m) m = c;
  if (d < m) m = d;
  return m;
}

/*
 * Values are levels, not ink: 0 darkest, levels-1 lightest. The timing ring
 * cycles through every level so a multi-level frame carries its own brightness
 * calibration, and a receiver can tell the depths apart by which pattern fits.
 */
int vdtp_structure_at(const vdtp_layout *l, int r, int c) {
  int hi = l->n - 1, top = l->levels - 1;
  int ring = min4(r, c, hi - r, hi - c);
  if (ring == 0) return 0;
  if (ring == 1) return top;
  if (ring == 2) {
    int along = (r == ring || r == hi - ring) ? c : r;
    return along % l->levels;
  }
  int lo = VDTP_BORDER, hii = l->n - VDTP_BORDER - 1;
  if (r - lo < VDTP_ORIENT && c - lo < VDTP_ORIENT) return 0;   /* top-left: darkest */
  if (r - lo < VDTP_ORIENT && hii - c < VDTP_ORIENT) return top;
  if (hii - r < VDTP_ORIENT && c - lo < VDTP_ORIENT) return top;
  if (hii - r < VDTP_ORIENT && hii - c < VDTP_ORIENT) return top;
  return -1;
}

int vdtp_matrix_encode(const vdtp_layout *l, const uint8_t *bytes, size_t len, uint8_t *cells) {
  if (len > (size_t)l->capacity_bytes) return -1;
  int n = l->n;
  for (int r = 0; r < n; r++) {
    for (int c = 0; c < n; c++) {
      int s = vdtp_structure_at(l, r, c);
      cells[r * n + c] = (uint8_t)(s >= 0 ? s : 0);
    }
  }
  int bit = 0, lo = VDTP_BORDER, hi = n - VDTP_BORDER - 1, w = l->bits_per_cell;
  for (int r = lo; r <= hi; r++) {
    for (int c = lo; c <= hi; c++) {
      if (vdtp_structure_at(l, r, c) >= 0) continue; /* reserved */
      cells[r * n + c] = (uint8_t)map_symbol(l, read_bits(bytes, len, bit, w));
      bit += w;
    }
  }
  return 0;
}

/*
 * Emits parity vectors for test/parity.test.js.
 *
 * Each line is "<name>\t<sha256 of a canonical serialisation>". The JS side
 * builds the same serialisation from core/ and visual/ and compares digests, so
 * any divergence between the C sender and the JS receiver fails the build
 * instead of silently corrupting a transfer.
 */
#include "vdtp.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { uint8_t *p; size_t len, cap; } buf;

static void bput(buf *b, const void *src, size_t n) {
  if (b->len + n > b->cap) {
    b->cap = (b->len + n) * 2 + 64;
    b->p = (uint8_t *)realloc(b->p, b->cap);
  }
  memcpy(b->p + b->len, src, n);
  b->len += n;
}
static void bu32(buf *b, uint32_t v) {
  uint8_t t[4] = {(uint8_t)(v>>24),(uint8_t)(v>>16),(uint8_t)(v>>8),(uint8_t)v};
  bput(b, t, 4);
}
static void emit(const char *name, buf *b) {
  uint8_t d[32]; char hex[65];
  vdtp_sha256(b->p, b->len, d);
  vdtp_hex(d, 32, hex);
  printf("%s\t%s\t%zu\n", name, hex, b->len);
  free(b->p);
  b->p = NULL; b->len = b->cap = 0;
}

/* Same generator as the JS test helper `rand`: raw xorshift32, no mixing. */
static void fill_rand(uint8_t *out, size_t n, uint32_t seed) {
  uint32_t s = seed ? seed : 1;
  for (size_t i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    out[i] = (uint8_t)(s & 0xff);
  }
}

int main(void) {
  buf b = {0};

  for (uint32_t x = 0; x < 2000; x++) bu32(&b, vdtp_mix32(x));
  for (uint32_t x = 0xfffff000u; x != 0; x++) bu32(&b, vdtp_mix32(x));
  emit("mix32", &b);

  const uint32_t seeds[] = {1, 2, 3, 1000, 65535, 0x7fffffffu, 0xffffffffu, 0};
  for (size_t i = 0; i < sizeof(seeds)/sizeof(*seeds); i++) {
    vdtp_rng r; vdtp_rng_init(&r, seeds[i]);
    for (int j = 0; j < 200; j++) bu32(&b, vdtp_rng_next(&r));
  }
  emit("rng", &b);

  for (size_t n = 0; n <= 300; n++) {
    uint8_t *tmp = (uint8_t *)malloc(n ? n : 1);
    fill_rand(tmp, n, (uint32_t)(n + 1));
    bu32(&b, vdtp_crc32(tmp, n));
    free(tmp);
  }
  emit("crc32", &b);

  const size_t lens[] = {0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096, 65536};
  for (size_t i = 0; i < sizeof(lens)/sizeof(*lens); i++) {
    uint8_t *tmp = (uint8_t *)malloc(lens[i] ? lens[i] : 1);
    fill_rand(tmp, lens[i], (uint32_t)(i + 7));
    uint8_t d[32];
    vdtp_sha256(tmp, lens[i], d);
    bput(&b, d, 32);
    free(tmp);
  }
  emit("sha256", &b);

  /* The critical one: the quantised degree distribution, in full. */
  const int Ks[] = {1, 2, 7, 64, 205, 256, 512, 1400, 2048, 4096};
  for (size_t i = 0; i < sizeof(Ks)/sizeof(*Ks); i++) {
    vdtp_soliton s;
    if (vdtp_soliton_init(&s, Ks[i]) != 0) { fprintf(stderr, "soliton init failed\n"); return 1; }
    for (int j = 0; j <= Ks[i]; j++) bu32(&b, s.cdf[j]);
    vdtp_soliton_free(&s);
  }
  emit("soliton_cdf", &b);

  const int NKs[] = {64, 256, 2048};
  for (size_t i = 0; i < sizeof(NKs)/sizeof(*NKs); i++) {
    vdtp_soliton s;
    vdtp_soliton_init(&s, NKs[i]);
    for (uint32_t seed = 1; seed <= 5000; seed++) {
      int d = vdtp_neighbours(&s, seed);
      bu32(&b, (uint32_t)d);
      for (int j = 0; j < d; j++) bu32(&b, (uint32_t)s.idx[j]);
    }
    vdtp_soliton_free(&s);
  }
  emit("neighbours", &b);

  {
    /* Both an exact multiple of the block size and a ragged tail, so that any
       disagreement about zero-padding the last block shows up here. */
    const size_t lens2[] = {64 * 1024, 64 * 1024 + 377};
    for (size_t i = 0; i < 2; i++) {
      uint8_t *data = (uint8_t *)malloc(lens2[i]);
      fill_rand(data, lens2[i], 4242);
      vdtp_encoder e;
      vdtp_encoder_init(&e, data, lens2[i], 1024);
      uint8_t *sym = (uint8_t *)malloc(1024);
      bu32(&b, (uint32_t)e.K);
      for (uint32_t seed = 1; seed <= 400; seed++) {
        vdtp_encoder_symbol(&e, seed, sym);
        bput(&b, sym, 1024);
      }
      free(sym); vdtp_encoder_free(&e); free(data);
    }
  }
  emit("lt_symbols", &b);

  for (int nsym = 2; nsym <= 40; nsym += 2) {
    for (int k = 8; k <= 120; k += 8) {
      uint8_t *in = (uint8_t *)malloc((size_t)k);
      uint8_t *out = (uint8_t *)malloc((size_t)(k + nsym));
      fill_rand(in, (size_t)k, (uint32_t)(k * 31 + nsym));
      vdtp_rs_encode(in, k, nsym, out);
      bput(&b, out, (size_t)(k + nsym));
      free(in); free(out);
    }
  }
  emit("rs_encode", &b);

  {
    const int caps[] = {418, 1010, 1858, 4322, 8100};
    for (size_t i = 0; i < sizeof(caps)/sizeof(*caps); i++) {
      vdtp_ecc_plan p;
      if (vdtp_ecc_plan_init(&p, caps[i], VDTP_ECC_REDUNDANCY) != 0) {
        fprintf(stderr, "ecc plan failed\n"); return 1;
      }
      bu32(&b, (uint32_t)p.blocks);
      bu32(&b, (uint32_t)p.data_bytes);
      for (int j = 0; j < p.blocks; j++) { bu32(&b, (uint32_t)p.sizes[j]); bu32(&b, (uint32_t)p.parity[j]); }

      uint8_t *data = (uint8_t *)malloc((size_t)p.data_bytes);
      uint8_t *wire = (uint8_t *)malloc((size_t)caps[i]);
      fill_rand(data, (size_t)p.data_bytes, (uint32_t)caps[i]);
      if (vdtp_ecc_encode(&p, data, (size_t)p.data_bytes, wire) != 0) {
        fprintf(stderr, "ecc encode failed\n"); return 1;
      }
      bput(&b, wire, (size_t)caps[i]);
      free(data); free(wire);
      vdtp_ecc_plan_free(&p);
    }
  }
  emit("ecc_encode", &b);

  {
    uint8_t payload[1000];
    fill_rand(payload, sizeof(payload), 31);
    uint8_t out[1000 + VDTP_OVERHEAD];
    size_t n = vdtp_frame_encode(out, VDTP_DATA, 0xdeadbeefu, 42, 0x1234abcdu, 2,
                                 payload, sizeof(payload));
    bu32(&b, (uint32_t)n);
    bput(&b, out, n);
  }
  emit("frame", &b);

  {
    const int gs[] = {32, 48, 64, 96, 128, 160, 192, 256};
    const int bl[] = {2, 4, 8};
    for (size_t k = 0; k < sizeof(bl)/sizeof(*bl); k++)
    for (size_t i = 0; i < sizeof(gs)/sizeof(*gs); i++) {
      vdtp_layout l;
      if (vdtp_layout_init(&l, gs[i], bl[k]) != 0) continue;
      vdtp_band_plan p;
      if (vdtp_plan_bands(&l, VDTP_ECC_REDUNDANCY, &p) != 0) { fprintf(stderr, "band plan\n"); return 1; }
      bu32(&b, (uint32_t)p.count);
      bu32(&b, (uint32_t)p.payload);
      bu32(&b, (uint32_t)p.frame_budget);
      for (int j = 0; j < p.count; j++) {
        bu32(&b, (uint32_t)p.bands[j].from);
        bu32(&b, (uint32_t)p.bands[j].to);
        bu32(&b, (uint32_t)p.bands[j].bits);
        bu32(&b, (uint32_t)p.bands[j].bytes);
      }
    }
  }
  emit("band_plan", &b);

  {
    const int ns[] = {64, 128, 256};
    const int lv[] = {2, 4, 8};
    for (size_t k = 0; k < sizeof(lv)/sizeof(*lv); k++)
    for (size_t i = 0; i < sizeof(ns)/sizeof(*ns); i++) {
      vdtp_layout l;
      vdtp_layout_init(&l, ns[i], lv[k]);
      bu32(&b, (uint32_t)l.capacity_bytes);
      uint8_t *data = (uint8_t *)malloc((size_t)l.capacity_bytes);
      fill_rand(data, (size_t)l.capacity_bytes, (uint32_t)ns[i]);
      uint8_t *cells = (uint8_t *)malloc((size_t)ns[i] * ns[i]);
      vdtp_matrix_encode(&l, data, (size_t)l.capacity_bytes, cells);
      bput(&b, cells, (size_t)ns[i] * ns[i]);
      free(cells); free(data);
    }
  }
  emit("matrix", &b);

  return 0;
}

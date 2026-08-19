/*
 * Minimal DEFLATE encoder (RFC 1951), fixed-Huffman blocks with LZ77 matching.
 *
 * Standard-format output on purpose: the receiver inflates with the browser's
 * own DecompressionStream('deflate-raw'), so the decoder side costs nothing and
 * cannot drift from this encoder. Fixed Huffman rather than dynamic because the
 * table it saves is worth a few percent against a few hundred lines of code,
 * and the ratio that matters here comes from the match finder.
 *
 * Compression is worth having on a channel this slow — text and logs shrink 2-4x,
 * which is a bigger win than anything left in the visual layer — while already
 * compressed files simply pass through at ratio ~1.
 */
#include "vdtp.h"
#include <stdlib.h>
#include <string.h>

#define WINDOW      32768
#define MIN_MATCH   3
#define MAX_MATCH   258
#define HASH_BITS   15
#define HASH_SIZE   (1 << HASH_BITS)
#define MAX_CHAIN   32          /* search depth: ratio against speed */

typedef struct {
  uint8_t *out;
  size_t   cap, len;
  uint32_t bits;
  int      nbits;
  int      overflow;
} bitwriter;

static void put_bits(bitwriter *w, uint32_t value, int count) {
  w->bits |= (value & ((1u << count) - 1u)) << w->nbits;
  w->nbits += count;
  while (w->nbits >= 8) {
    if (w->len >= w->cap) { w->overflow = 1; return; }
    w->out[w->len++] = (uint8_t)(w->bits & 0xff);
    w->bits >>= 8;
    w->nbits -= 8;
  }
}

/* Huffman codes travel most-significant bit first inside an LSB-first stream. */
static void put_huff(bitwriter *w, uint32_t code, int len) {
  uint32_t reversed = 0;
  for (int i = 0; i < len; i++) reversed |= ((code >> i) & 1u) << (len - 1 - i);
  put_bits(w, reversed, len);
}

static void put_literal(bitwriter *w, int lit) {
  if (lit < 144) put_huff(w, 0x30u + (uint32_t)lit, 8);
  else           put_huff(w, 0x190u + (uint32_t)(lit - 144), 9);
}

static void put_symbol(bitwriter *w, int sym) {
  if (sym < 256) { put_literal(w, sym); return; }
  if (sym < 280) put_huff(w, (uint32_t)(sym - 256), 7);
  else           put_huff(w, 0xc0u + (uint32_t)(sym - 280), 8);
}

static const uint16_t LEN_BASE[29] = {
  3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258
};
static const uint8_t LEN_EXTRA[29] = {
  0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0
};
static const uint16_t DIST_BASE[30] = {
  1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,
  1025,1537,2049,3073,4097,6145,8193,12289,16385,24577
};
static const uint8_t DIST_EXTRA[30] = {
  0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13
};

static void put_match(bitwriter *w, int length, int distance) {
  int lc = 28;
  while (lc > 0 && length < LEN_BASE[lc]) lc--;
  put_symbol(w, 257 + lc);
  if (LEN_EXTRA[lc]) put_bits(w, (uint32_t)(length - LEN_BASE[lc]), LEN_EXTRA[lc]);

  int dc = 29;
  while (dc > 0 && distance < DIST_BASE[dc]) dc--;
  put_huff(w, (uint32_t)dc, 5);
  if (DIST_EXTRA[dc]) put_bits(w, (uint32_t)(distance - DIST_BASE[dc]), DIST_EXTRA[dc]);
}

static uint32_t hash3(const uint8_t *p) {
  return (uint32_t)(((p[0] << 16) ^ (p[1] << 8) ^ p[2]) * 2654435761u) >> (32 - HASH_BITS);
}

size_t vdtp_deflate(const uint8_t *src, size_t len, uint8_t *out, size_t cap) {
  bitwriter w = { out, cap, 0, 0, 0, 0 };

  int32_t *head = (int32_t *)malloc(sizeof(int32_t) * HASH_SIZE);
  int32_t *prev = (int32_t *)malloc(sizeof(int32_t) * (len ? len : 1));
  if (!head || !prev) { free(head); free(prev); return 0; }
  for (int i = 0; i < HASH_SIZE; i++) head[i] = -1;

  put_bits(&w, 1, 1);   /* final block */
  put_bits(&w, 1, 2);   /* fixed Huffman */

  size_t pos = 0;
  while (pos < len) {
    int best_len = 0, best_dist = 0;
    if (pos + MIN_MATCH <= len) {
      uint32_t h = hash3(src + pos);
      int32_t cand = head[h];
      int chain = MAX_CHAIN;
      while (cand >= 0 && chain-- > 0) {
        size_t dist = pos - (size_t)cand;
        if (dist == 0 || dist > WINDOW) break;
        size_t maxlen = len - pos;
        if (maxlen > MAX_MATCH) maxlen = MAX_MATCH;
        size_t l = 0;
        while (l < maxlen && src[cand + l] == src[pos + l]) l++;
        if ((int)l > best_len) { best_len = (int)l; best_dist = (int)dist; if (l == maxlen) break; }
        cand = prev[cand];
      }
      prev[pos] = head[h];
      head[h] = (int32_t)pos;
    }

    if (best_len >= MIN_MATCH) {
      put_match(&w, best_len, best_dist);
      /* Index the bytes the match covered so later matches can reach them. */
      for (int i = 1; i < best_len && pos + (size_t)i + MIN_MATCH <= len; i++) {
        uint32_t h = hash3(src + pos + i);
        prev[pos + i] = head[h];
        head[h] = (int32_t)(pos + i);
      }
      pos += (size_t)best_len;
    } else {
      put_literal(&w, src[pos]);
      pos++;
    }
    if (w.overflow) break;
  }

  put_symbol(&w, 256);            /* end of block */
  if (w.nbits > 0) put_bits(&w, 0, 8 - w.nbits);

  free(head); free(prev);
  return w.overflow ? 0 : w.len;
}

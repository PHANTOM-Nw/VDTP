/*
 * Host-side harness: runs the real sender pipeline from native/vdtp.c and dumps
 * what the screen would show, so test/native.test.js can push it through the
 * shipped JS receiver. Verifies everything in the Windows sender except the
 * Win32 window itself.
 *
 *   emit <file> <grid> <count> [bootstrap] [ecc]
 *      -> stdout: header, then `bootstrap` handshake frames followed by
 *         `count` stream frames, matching what the sender actually plays.
 */
#include "vdtp.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc < 4 || argc > 7) {
    fprintf(stderr, "usage: emit <file> <grid> <count> [bootstrap] [ecc] [levels]\n");
    return 2;
  }
  int grid = atoi(argv[2]), count = atoi(argv[3]);
  int bootstrap = argc >= 5 ? atoi(argv[4]) : 0;
  int ecc = argc >= 6 ? atoi(argv[5]) : 0;
  int levels = argc >= 7 ? atoi(argv[6]) : 2;

  FILE *f = fopen(argv[1], "rb");
  if (!f) { perror("open"); return 1; }
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t *data = (uint8_t *)malloc((size_t)len);
  if (fread(data, 1, (size_t)len, f) != (size_t)len) { fprintf(stderr, "short read\n"); return 1; }
  fclose(f);

  vdtp_layout layout;
  if (vdtp_layout_init(&layout, grid, levels) != 0) { fprintf(stderr, "bad grid\n"); return 1; }
  /* The band plan decides the payload size, so it has to be known before the
     metadata is written — the metadata's `block` field is what the receiver
     builds its fountain decoder from, and a stale value reconstructs a file
     that looks complete and fails its SHA-256. */
  vdtp_band_plan plan;
  if (vdtp_plan_bands(&layout, VDTP_ECC_REDUNDANCY, &plan) != 0) {
    fprintf(stderr, "band plan failed\n"); return 1;
  }
  int block_size = plan.frame_budget;

  /* SHA-256 covers the original file, so the integrity check still describes
     what the user sent rather than what happened to travel. */
  uint8_t digest[32]; char sha_hex[65];
  vdtp_sha256(data, (size_t)len, digest);
  vdtp_hex(digest, 32, sha_hex);

  /* Compress only if it helped: an already-compressed file gains nothing and
     shipping a larger stream to discover that would be worse than not trying. */
  const uint8_t *wire = data;
  size_t wire_len = (size_t)len;
  uint8_t *comp = (uint8_t *)malloc((size_t)len + 1024);
  if (comp) {
    size_t got = vdtp_deflate(data, (size_t)len, comp, (size_t)len + 1024);
    if (got > 0 && got < (size_t)len) { wire = comp; wire_len = got; }
  }
  const char *compression = wire == data ? "none" : "deflate";

  /* Fixed session id so the test is reproducible. */
  uint8_t sid[16];
  for (int i = 0; i < 16; i++) sid[i] = (uint8_t)(0x10 + i);
  char sid_hex[33];
  vdtp_hex(sid, 16, sid_hex);
  uint32_t tag = ((uint32_t)sid[0] << 24) | ((uint32_t)sid[1] << 16)
               | ((uint32_t)sid[2] << 8) | (uint32_t)sid[3];

  char meta[2048];
  int meta_len = snprintf(meta, sizeof(meta),
    "{\"v\":1,\"sid\":\"%s\",\"name\":\"%s\",\"size\":%lld,\"mime\":\"application/octet-stream\","
    "\"sha256\":\"%s\",\"block\":%d,\"k\":%d,\"fec\":\"lt\",\"ecc\":0,"
    "\"compression\":\"%s\",\"csize\":%zu,\"encryption\":\"none\"}",
    sid_hex, "payload.bin", (long long)len, sha_hex, block_size,
    (int)((wire_len + (size_t)block_size - 1) / (size_t)block_size),
    compression, wire_len);

  /* Same stream implementation the Windows sender plays. */
  vdtp_stream stream;
  if (vdtp_stream_init(&stream, wire, wire_len, layout.capacity_bytes,
                       ecc ? plan.frame_budget : 0, tag, meta, (size_t)meta_len, ecc) != 0) {
    fprintf(stderr, "stream init failed\n");
    return 1;
  }
  uint8_t *cells = (uint8_t *)malloc((size_t)grid * grid);

  /* One buffer per band, each sized to its band exactly. */
  uint8_t *bandbuf[VDTP_MAX_BANDS];
  const uint8_t *bandptr[VDTP_MAX_BANDS];
  for (int i = 0; i < plan.count; i++) {
    bandbuf[i] = (uint8_t *)malloc((size_t)plan.bands[i].bytes);
    bandptr[i] = bandbuf[i];
  }

  /* header: "VDTPEMIT", grid, count, sha256 hex */
  fwrite("VDTPEMIT", 1, 8, stdout);
  uint8_t hdr[8] = {
    (uint8_t)(grid >> 8), (uint8_t)grid,
    (uint8_t)((count + bootstrap) >> 8), (uint8_t)(count + bootstrap),
    (uint8_t)(stream.enc.K >> 8), (uint8_t)stream.enc.K,
    (uint8_t)(block_size >> 8), (uint8_t)block_size,
  };
  fwrite(hdr, 1, 8, stdout);
  fwrite(sha_hex, 1, 64, stdout);

  /* Metadata gets a whole matrix: it is held static during the handshake, so
     tearing cannot reach it, and a band's budget is below what it needs. */
  for (int i = 0; i < bootstrap; i++) {
    size_t n = vdtp_stream_metadata(&stream);
    vdtp_matrix_encode(&layout, stream.frame, n, cells);
    fwrite(cells, 1, (size_t)grid * grid, stdout);
  }
  if (bootstrap) vdtp_stream_rewind(&stream);

  int since_meta = 0;
  for (int i = 0; i < count; i++) {
    if (since_meta == 0 || since_meta > 6) {
      since_meta = 1;
      size_t n = vdtp_stream_metadata(&stream);
      vdtp_matrix_encode(&layout, stream.frame, n, cells);
    } else {
      since_meta++;
      for (int bnd = 0; bnd < plan.count; bnd++) {
        size_t n = vdtp_stream_data(&stream);
        if (ecc) {
          vdtp_ecc_plan bp;
          if (vdtp_ecc_plan_init(&bp, plan.bands[bnd].bytes, VDTP_ECC_REDUNDANCY) != 0) return 1;
          if (vdtp_ecc_encode(&bp, stream.frame, n, bandbuf[bnd]) != 0) return 1;
          vdtp_ecc_plan_free(&bp);
        } else {
          memset(bandbuf[bnd], 0, (size_t)plan.bands[bnd].bytes);
          memcpy(bandbuf[bnd], stream.frame, n);
        }
      }
      vdtp_encode_bands(&layout, &plan, bandptr, cells);
    }
    fwrite(cells, 1, (size_t)grid * grid, stdout);
  }

  for (int i = 0; i < plan.count; i++) free(bandbuf[i]);
  free(cells); free(data);
  vdtp_stream_free(&stream);
  return 0;
}

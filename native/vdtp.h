/*
 * VDTP sender core, portable C99.
 *
 * Encode path only: the Windows sender never decodes. Every function here has a
 * JavaScript counterpart in core/ and visual/, and the two MUST agree bit for
 * bit — the receiver regenerates each symbol's neighbour set from the seed
 * alone. test/parity.test.js proves the agreement against native/vectors.c.
 */
#ifndef VDTP_H
#define VDTP_H

#include <stddef.h>
#include <stdint.h>

/* ---- deterministic PRNG (mirrors core/prng.js) ---- */
uint32_t vdtp_mix32(uint32_t x);

typedef struct { uint32_t s; } vdtp_rng;
void     vdtp_rng_init(vdtp_rng *r, uint32_t seed);
uint32_t vdtp_rng_next(vdtp_rng *r);

/* ---- integrity (mirrors core/crc32.js, core/sha256.js) ---- */
uint32_t vdtp_crc32(const uint8_t *data, size_t len);
void     vdtp_sha256(const uint8_t *data, size_t len, uint8_t out[32]);
void     vdtp_hex(const uint8_t *bytes, size_t len, char *out);

/* ---- LT fountain code (mirrors core/lt.js) ---- */
#define VDTP_CDF_SCALE (1u << 24)

typedef struct {
  int       K;
  uint32_t *cdf;      /* [0..K], quantised to VDTP_CDF_SCALE */
  uint8_t  *seen;     /* K bytes, scratch for neighbour de-duplication */
  int      *idx;      /* K ints, scratch for the neighbour list */
} vdtp_soliton;

int  vdtp_soliton_init(vdtp_soliton *s, int K);
void vdtp_soliton_free(vdtp_soliton *s);
/* Returns the degree; indices land in s->idx. */
int  vdtp_neighbours(vdtp_soliton *s, uint32_t seed);

typedef struct {
  const uint8_t *data;
  size_t         len;
  int            block_size;
  int            K;
  vdtp_soliton   soliton;
} vdtp_encoder;

int  vdtp_encoder_init(vdtp_encoder *e, const uint8_t *data, size_t len, int block_size);
void vdtp_encoder_free(vdtp_encoder *e);
/* Writes block_size bytes into out. Seeds 1..K are the systematic prefix. */
void vdtp_encoder_symbol(vdtp_encoder *e, uint32_t seed, uint8_t *out);

/* ---- frame wire format (mirrors core/frame.js) ---- */
#define VDTP_MAGIC        0x56445450u
#define VDTP_VERSION      1
#define VDTP_HEADER_SIZE  21
#define VDTP_TRAILER_SIZE 4
#define VDTP_OVERHEAD     (VDTP_HEADER_SIZE + VDTP_TRAILER_SIZE)

enum { VDTP_BOOTSTRAP = 0, VDTP_SYNC = 1, VDTP_DATA = 2, VDTP_END = 3 };

size_t vdtp_frame_encode(uint8_t *out, uint8_t type, uint32_t session_tag,
                         uint32_t frame_id, uint32_t seed, uint8_t ecc_level,
                         const uint8_t *payload, size_t payload_len);

/* ---- Reed-Solomon + interleaving (mirrors core/rs.js, core/ecc.js) ----
 *
 * Encode side only; the Windows sender never corrects. Must match the JS bit
 * for bit — the receiver de-interleaves and corrects with the tables in
 * core/rs.js, and a generator polynomial or block split that differs by one
 * symbol makes every frame uncorrectable with nothing to point at.
 */
#define VDTP_ECC_REDUNDANCY 0.12

/* Appends nsym parity symbols after k data symbols. out holds k + nsym. */
void vdtp_rs_encode(const uint8_t *data, int k, int nsym, uint8_t *out);

typedef struct {
  int  blocks;
  int *sizes;    /* symbols per block, largest first where uneven */
  int *parity;   /* parity symbols per block */
  int  capacity;
  int  data_bytes;
} vdtp_ecc_plan;

int  vdtp_ecc_plan_init(vdtp_ecc_plan *p, int capacity, double redundancy);
void vdtp_ecc_plan_free(vdtp_ecc_plan *p);
/* Payload bytes a frame of `capacity` can carry at this redundancy, or -1. */
int  vdtp_ecc_capacity(int capacity, double redundancy);
/* data -> exactly plan->capacity interleaved symbols. Returns 0 on success. */
int  vdtp_ecc_encode(const vdtp_ecc_plan *p, const uint8_t *data, size_t len, uint8_t *out);

/* ---- frame stream (mirrors VdtpSender.stream() in core/session.js) ----
 *
 * Owned here rather than in each front end. The Windows sender and the test
 * harness previously each carried their own copy of this loop; they drifted,
 * and only the harness copy was covered by tests, which hid a heap overflow in
 * the shipped one. Anything that plays frames must go through vdtp_stream.
 */
#define VDTP_METADATA_INTERVAL 48

typedef struct {
  vdtp_encoder enc;
  uint32_t     session_tag;
  const char  *meta_json;
  size_t       meta_len;
  uint8_t     *frame;        /* capacity_bytes, holds the serialised frame */
  uint8_t     *payload;      /* block_size, scratch for one fountain symbol */
  int          capacity_bytes;
  int          block_size;
  uint32_t     seed;
  uint32_t     frame_id;
  int          since_meta;
  int          meta_interval;
  int           ecc;         /* wrap frames in intra-frame correction */
  vdtp_ecc_plan plan;
  uint8_t      *wire;        /* capacity_bytes, the interleaved frame */
} vdtp_stream;

/*
 * `meta_json` is borrowed, not copied: it must outlive the stream.
 * Returns 0 on success, -1 on bad parameters or allocation failure.
 */
/*
 * `frame_capacity` sizes the metadata frame, which gets a whole matrix to
 * itself. `payload_budget` sizes each data frame; pass the band plan's
 * frame_budget so one payload size fits every band, or 0 to derive it from the
 * whole matrix for an unbanded sender.
 */
int    vdtp_stream_init(vdtp_stream *s, const uint8_t *data, size_t len,
                        int frame_capacity, int payload_budget, uint32_t session_tag,
                        const char *meta_json, size_t meta_len, int ecc);
/* Always a data frame, letting the caller schedule metadata matrices itself. */
size_t vdtp_stream_data(vdtp_stream *s);
void   vdtp_stream_free(vdtp_stream *s);
/* Serialises the next frame into s->frame and returns its length. */
size_t vdtp_stream_next(vdtp_stream *s);
/* Just the metadata frame, without consuming a fountain seed. Used by the
   bootstrap phase, where the sender holds on one frame until the operator has
   confirmed the receiver can read it. */
size_t vdtp_stream_metadata(vdtp_stream *s);
/* Restart the display sequence; the fountain seed keeps climbing. */
void   vdtp_stream_rewind(vdtp_stream *s);

/* ---- DEFLATE (RFC 1951, raw) ----
 *
 * Standard format so the receiver can inflate with the browser's built-in
 * DecompressionStream and no decoder has to be written or kept in step.
 * Returns the compressed length, or 0 if it did not fit in `cap`.
 */
size_t vdtp_deflate(const uint8_t *src, size_t len, uint8_t *out, size_t cap);

/* ---- visual matrix (mirrors visual/matrix.js) ---- */
#define VDTP_BORDER 3
#define VDTP_ORIENT 2
#define VDTP_QUIET  2

/*
 * `levels` is what a module carries:
 *   2  one bit, black and white
 *   4  two bits, grey levels
 *   8  three bits, one per colour channel — value is (R<<2)|(G<<1)|B
 *
 * Depth buys payload without shrinking the module, which is what matters when
 * the binding limit is spatial frequency rather than contrast. Eight is colour
 * rather than eight greys because three independent binary decisions each keep
 * the full margin of plain binary, where four grey levels leave a third of it.
 */
typedef struct {
  int n, levels, bits_per_cell, inner, cells, capacity_bits, capacity_bytes;
} vdtp_layout;

int vdtp_layout_init(vdtp_layout *l, int n, int levels);
int vdtp_structure_at(const vdtp_layout *l, int r, int c); /* -1 => payload cell */
/* Writes n*n cells (0/1). Returns 0 on success, -1 if len exceeds capacity. */
int vdtp_matrix_encode(const vdtp_layout *l, const uint8_t *bytes, size_t len, uint8_t *cells);

/* ---- horizontal bands (mirrors planBands/encodeBands in visual/matrix.js) ----
 *
 * A capture that spans a screen update loses only the band straddling the tear;
 * the bands above came whole from one displayed frame and those below from the
 * next, and both are good symbols. Geometry is derived identically on both ends
 * from the grid alone, so nothing has to be negotiated.
 */
#define VDTP_MAX_BANDS 8
#define VDTP_TEAR_RATE 0.4

typedef struct { int from, to, bits, bytes; } vdtp_band;

typedef struct {
  int       count;
  vdtp_band bands[VDTP_MAX_BANDS];
  int       payload;       /* total payload across all bands */
  int       frame_budget;  /* payload of the smallest band: one size fits all */
} vdtp_band_plan;

int vdtp_plan_bands(const vdtp_layout *l, double redundancy, vdtp_band_plan *out);
/* buffers[i] must be exactly bands[i].bytes long. */
int vdtp_encode_bands(const vdtp_layout *l, const vdtp_band_plan *p,
                      const uint8_t *const *buffers, uint8_t *cells);

#endif /* VDTP_H */

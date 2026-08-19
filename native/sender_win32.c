/*
 * VDTP Windows sender. Win32 + GDI only — no runtime, no browser, no installer.
 *
 * The frame stream lives in vdtp_stream (native/vdtp.c), shared with the test
 * harness, so what ships is what is tested. An earlier version kept its own
 * copy of the loop and carved the symbol scratch out of the tail of the frame
 * buffer, overflowing the heap on the first data frame; the harness had it
 * right and the shipped code did not, which is exactly what sharing prevents.
 */
#define WIN32_LEAN_AND_MEAN
/* UNICODE/_UNICODE come from -municode */
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <bcrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vdtp.h"

#define ID_PICK  101
#define ID_GRID  102
#define ID_FPS   103
#define ID_START 104
#define ID_ECC   105
#define ID_LEVELS 106
#define ID_CLEAR 107

/* Data matrices between metadata matrices. */
#define METADATA_EVERY 6

/* 32 is here because halving the module count doubles pixels per module and
   halves the payload's spatial frequency — the only real defence against blur
   and moire, which destroy fine detail while leaving the rings readable. */
/* Must stay a subset of CANDIDATE_SIZES in visual/scan.js. */
static const int GRIDS[] = {32, 48, 64, 96, 128, 160, 192, 256};
/* Frame rate trades against the fraction of captures that span a screen
   update, and that fraction depends on the camera's exposure, which we cannot
   see. Measured at a 33 ms capture window 30 FPS still keeps 79%; at 100 ms it
   collapses to zero. So the range is offered and the receiver reports which
   end of it the room can actually sustain. */
static const int FPSES[] = {5, 10, 15, 20, 25, 30};
#define NGRIDS ((int)(sizeof(GRIDS)/sizeof(*GRIDS)))
#define NFPSES ((int)(sizeof(FPSES)/sizeof(*FPSES)))

typedef struct {
  uint8_t  *data;
  size_t    len;
  uint8_t  *wire;        /* deflate-raw form when it is smaller than data */
  size_t    wire_len;
  int       compressed;
  char      name_utf8[512];
  char      mime[64];
  char      sha_hex[65];
  uint8_t   sid[16];
  uint32_t  session_tag;

  int         grid_i, fps_i;
  vdtp_layout layout;
  vdtp_stream stream;
  int         stream_open;
  int            block_size;
  int            ecc;
  int            levels;
  int            ready;
  vdtp_band_plan plan;
  int            since_meta;

  char     *meta_json;
  size_t    meta_len;

  uint64_t  shown;
  DWORD     started_ms;
  int       bootstrap;   /* holding on the metadata frame, waiting for the operator */
} app_state;

static app_state g;
static HWND g_main, g_stage, g_info, g_pick, g_grid, g_fps, g_levels, g_clear, g_start, g_disclaimer;
static HBITMAP g_dib;
static HDC     g_back_dc;      /* off-screen composition target */
static HBITMAP g_back_bmp;
static HGDIOBJ g_back_old;
static int     g_back_w, g_back_h;
static WINDOWPLACEMENT g_prev_placement = { sizeof(WINDOWPLACEMENT), 0, 0, {0,0}, {0,0}, {0,0,0,0} };
static int g_fullscreen;
static uint32_t *g_pixels;
static int g_dib_side;
static uint8_t *g_cells;
static int g_cells_valid;
static uint8_t *g_bandbuf[VDTP_MAX_BANDS];
static const uint8_t *g_bandptr[VDTP_MAX_BANDS];

/* ---------- helpers ---------- */

static void die(const wchar_t *msg) { MessageBoxW(g_main, msg, L"VDTP", MB_ICONERROR); }
static void note(const wchar_t *msg) { MessageBoxW(g_main, msg, L"VDTP", MB_ICONINFORMATION); }

/* The settings the program opens with, in one place: 「清空」 restores exactly
   these, and a second copy of them would drift from the first.
   64x64 because 128 needs the frame to fill roughly twice the on-screen area to
   clear ~4 camera pixels per module, which a handheld shot of a monitor usually
   does not — the first hardware run never locked on. Correction is on by
   default: it buys about 1.5 density steps. Binary by default; 4 doubles the
   payload where contrast allows. */
static void set_defaults(void) {
  g.grid_i = 2;   /* 64x64 */
  g.fps_i = 1;    /* 10 FPS */
  g.ecc = 1;
  g.levels = 2;
}

/* UTF-8 -> UTF-16. Printing char* through %hs would decode it as the ANSI code
   page and mangle any non-ASCII file name. */
static void widen(const char *utf8, wchar_t *out, int cap) {
  if (MultiByteToWideChar(CP_UTF8, 0, utf8, -1, out, cap) == 0) {
    out[0] = 0;
  }
}

static const char *mime_for(const char *name) {
  const char *dot = strrchr(name, '.');
  if (!dot) return "application/octet-stream";
  struct { const char *ext, *mime; } t[] = {
    {".pdf","application/pdf"}, {".txt","text/plain"}, {".json","application/json"},
    {".png","image/png"}, {".jpg","image/jpeg"}, {".jpeg","image/jpeg"}, {".gif","image/gif"},
    {".zip","application/zip"}, {".csv","text/csv"}, {".xml","application/xml"},
    {".doc","application/msword"}, {".mp4","video/mp4"},
    {".docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    {".xlsx","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
  };
  for (size_t i = 0; i < sizeof(t)/sizeof(*t); i++) if (_stricmp(dot, t[i].ext) == 0) return t[i].mime;
  return "application/octet-stream";
}

static void json_escape(const char *in, char *out, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; in[i] && o + 8 < cap; i++) {
    unsigned char ch = (unsigned char)in[i];
    if (ch == '"' || ch == '\\') { out[o++] = '\\'; out[o++] = (char)ch; }
    else if (ch < 0x20) { o += (size_t)sprintf(out + o, "\\u%04x", ch); }
    else out[o++] = (char)ch;
  }
  out[o] = 0;
}

static void fill_random(uint8_t *out, size_t n) {
  if (BCryptGenRandom(NULL, out, (ULONG)n, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0) return;
  uint32_t s = (uint32_t)GetTickCount() ^ (uint32_t)GetCurrentProcessId();
  for (size_t i = 0; i < n; i++) { s = vdtp_mix32(s + (uint32_t)i); out[i] = (uint8_t)s; }
}

/* ---------- session setup ---------- */

static void close_stream(void) {
  if (g.stream_open) { vdtp_stream_free(&g.stream); g.stream_open = 0; }
}

static int build_session(void) {
  g.ready = 0;              /* never leave a stale session marked usable */
  close_stream();
  if (!g.data) return 0;

  if (vdtp_layout_init(&g.layout, GRIDS[g.grid_i], g.levels) != 0) { die(L"网格尺寸无效"); return 0; }
  /* The band plan sets the payload size, and it has to be known before the
     metadata is written: the metadata's block field is what the receiver
     builds its fountain decoder from, and a stale value reconstructs a file
     that looks complete and then fails its SHA-256. */
  if (vdtp_plan_bands(&g.layout, VDTP_ECC_REDUNDANCY, &g.plan) != 0) {
    die(L"网格太小，无法切分条带"); return 0;
  }
  g.block_size = g.plan.frame_budget;
  if (g.block_size < 32) { die(L"网格太小，无法承载一帧"); return 0; }

  for (int i = 0; i < VDTP_MAX_BANDS; i++) { free(g_bandbuf[i]); g_bandbuf[i] = NULL; }
  for (int i = 0; i < g.plan.count; i++) {
    g_bandbuf[i] = (uint8_t *)malloc((size_t)g.plan.bands[i].bytes);
    if (!g_bandbuf[i]) { die(L"内存不足"); return 0; }
    g_bandptr[i] = g_bandbuf[i];
  }

  char esc_name[1024], esc_mime[128], sid_hex[33];
  json_escape(g.name_utf8, esc_name, sizeof(esc_name));
  json_escape(g.mime, esc_mime, sizeof(esc_mime));
  vdtp_hex(g.sid, 16, sid_hex);

  free(g.meta_json);
  size_t cap = 2048;
  g.meta_json = (char *)malloc(cap);
  if (!g.meta_json) { die(L"内存不足"); return 0; }
  int n = snprintf(g.meta_json, cap,
    "{\"v\":1,\"sid\":\"%s\",\"name\":\"%s\",\"size\":%llu,\"mime\":\"%s\","
    "\"sha256\":\"%s\",\"block\":%d,\"k\":%d,\"fec\":\"lt\",\"ecc\":0,"
    "\"compression\":\"%s\",\"csize\":%llu,\"encryption\":\"none\"}",
    sid_hex, esc_name, (unsigned long long)g.len, esc_mime, g.sha_hex,
    g.block_size,
    (int)((g.wire_len + (size_t)g.block_size - 1) / (size_t)g.block_size),
    g.compressed ? "deflate" : "none", (unsigned long long)g.wire_len);
  if (n < 0 || (size_t)n >= cap) { die(L"元数据过长"); return 0; }
  g.meta_len = (size_t)n;

  if (vdtp_stream_init(&g.stream, g.compressed ? g.wire : g.data, g.wire_len,
                       g.layout.capacity_bytes, g.ecc ? g.plan.frame_budget : 0,
                       g.session_tag, g.meta_json, g.meta_len, g.ecc) != 0) {
    die(L"无法建立发送会话：文件名过长放不进当前网格，请提高网格密度或缩短文件名");
    return 0;
  }
  g.stream_open = 1;

  free(g_cells);
  g_cells = (uint8_t *)malloc((size_t)g.layout.n * g.layout.n);
  if (!g_cells) { close_stream(); die(L"内存不足"); return 0; }
  g_cells_valid = 0;

  g.ready = 1;
  return 1;
}

static void refresh_info(void) {
  EnableWindow(g_clear, g.data != NULL);
  if (!g.ready) {
    SetWindowTextW(g_info, L"尚未选择文件。\r\n\r\n把文件拖到本窗口，或点「选择文件…」。\r\n\r\n"
                           L"发送端持续循环播放编码帧，不需要知道接收端状态；"
                           L"接收端集齐足够编码块后自行恢复文件。");
    EnableWindow(g_start, FALSE);
    return;
  }
  wchar_t wname[512], wmime[128], buf[1400];
  widen(g.name_utf8, wname, 512);
  widen(g.mime, wmime, 128);

  int fps = FPSES[g.fps_i];
  int K = g.stream.enc.K;
  double frames = (double)K / g.plan.count * (1.0 + 1.0 / METADATA_EVERY);
  swprintf(buf, 1400,
    L"文件：%ls\r\n"
    L"大小：%.2f KB%ls   类型：%ls\r\n"
    L"SHA-256：%.32hs…\r\n\r\n"
    L"网格 %d × %d   %ls   %d 条带 × %d 字节   K = %d\r\n"
    L"理论吞吐 %.1f KB/s   无丢帧最短用时 %.1f 秒",
    wname, g.len / 1024.0, g.compressed ? L"（已压缩）" : L"", wmime, g.sha_hex,
    g.layout.n, g.layout.n,
    g.levels == 8 ? L"彩色 3bit" : (g.levels == 4 ? L"四级灰度" : L"黑白"),
    g.plan.count, g.block_size, K,
    (double)g.plan.payload * fps / 1024.0, frames / fps);
  SetWindowTextW(g_info, buf);
  EnableWindow(g_start, TRUE);
}

/* Shared by the file dialog and by a file dropped on the window. */
static void load_path(const wchar_t *path) {
  HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (h == INVALID_HANDLE_VALUE) { die(L"无法打开文件"); return; }
  LARGE_INTEGER size;
  if (!GetFileSizeEx(h, &size) || size.QuadPart <= 0 || size.QuadPart > 64LL * 1024 * 1024) {
    CloseHandle(h); die(L"文件为空或超过 64 MB 上限"); return;
  }
  uint8_t *buf = (uint8_t *)malloc((size_t)size.QuadPart);
  if (!buf) { CloseHandle(h); die(L"内存不足"); return; }

  size_t got = 0;
  while (got < (size_t)size.QuadPart) {
    DWORD chunk = (DWORD)((size.QuadPart - (LONGLONG)got > (1 << 20)) ? (1 << 20)
                                                                     : (size.QuadPart - (LONGLONG)got));
    DWORD read = 0;
    if (!ReadFile(h, buf + got, chunk, &read, NULL) || read == 0) break;
    got += read;
  }
  CloseHandle(h);
  if (got != (size_t)size.QuadPart) { free(buf); die(L"文件读取不完整"); return; }

  /* Retire the old session before the buffer it points at goes away. */
  close_stream();
  g.ready = 0;
  free(g.data);
  g.data = buf;
  g.len = got;

  const wchar_t *base = wcsrchr(path, L'\\');
  base = base ? base + 1 : path;
  WideCharToMultiByte(CP_UTF8, 0, base, -1, g.name_utf8, sizeof(g.name_utf8) - 1, NULL, NULL);
  snprintf(g.mime, sizeof(g.mime), "%s", mime_for(g.name_utf8));

  /* SHA-256 covers the original file: the integrity check should describe what
     the user sent, not what happened to travel. */
  uint8_t digest[32];
  vdtp_sha256(g.data, g.len, digest);
  vdtp_hex(digest, 32, g.sha_hex);

  /* Compress only if it helped. Already-compressed files gain nothing, and
     sending a larger stream to find that out would be worse than not trying. */
  free(g.wire);
  g.wire = NULL; g.wire_len = g.len; g.compressed = 0;
  uint8_t *comp = (uint8_t *)malloc(g.len + 1024);
  if (comp) {
    size_t got = vdtp_deflate(g.data, g.len, comp, g.len + 1024);
    if (got > 0 && got < g.len) { g.wire = comp; g.wire_len = got; g.compressed = 1; }
    else free(comp);
  }
  fill_random(g.sid, 16);
  g.session_tag = ((uint32_t)g.sid[0] << 24) | ((uint32_t)g.sid[1] << 16)
                | ((uint32_t)g.sid[2] << 8) | (uint32_t)g.sid[3];

  build_session();
  refresh_info();
}

static void pick_file(void) {
  wchar_t path[MAX_PATH] = {0};
  OPENFILENAMEW ofn = {0};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = g_main;
  ofn.lpstrFile = path;
  ofn.nMaxFile = MAX_PATH;
  ofn.lpstrFilter = L"所有文件\0*.*\0";
  ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
  if (!GetOpenFileNameW(&ofn)) return;
  load_path(path);
}

/* A file dragged onto the window, which is how an operator who already has the
   file in front of them expects to hand it over. Only the first is taken: this
   sends one file, and silently sending an arbitrary one of several would be
   worse than saying so. */
static void drop_files(HDROP drop) {
  wchar_t path[MAX_PATH] = {0};
  UINT count = DragQueryFileW(drop, 0xFFFFFFFF, NULL, 0);
  if (count > 0 && DragQueryFileW(drop, 0, path, MAX_PATH) > 0) {
    DWORD attr = GetFileAttributesW(path);
    if (attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)) {
      die(L"这是一个文件夹。请拖入单个文件。");
    } else {
      load_path(path);
      if (count > 1) note(L"一次只发送一个文件，已取第一个。");
    }
  }
  DragFinish(drop);
}

/* ---------- playback ---------- */

static void ensure_dib(int side) {
  if (g_dib && g_dib_side == side) return;
  if (g_dib) { DeleteObject(g_dib); g_dib = NULL; g_pixels = NULL; }
  BITMAPINFO bi = {0};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = side;
  bi.bmiHeader.biHeight = -side;   /* top-down */
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  g_dib = CreateDIBSection(NULL, &bi, DIB_RGB_COLORS, (void **)&g_pixels, NULL, 0);
  g_dib_side = g_dib ? side : 0;
}

/* Advance the stream. Called from the timer only — never from WM_PAINT, or an
   incidental repaint would consume a frame and the displayed rate would depend
   on how often Windows decides to redraw. */
static void advance_frame(void) {
  if (!g.ready) return;

  /* Bootstrap holds on the metadata frame at the *same* density as the data.
     A lower-density bootstrap would be easier to acquire and would therefore
     prove nothing: reading it is exactly the evidence that this distance and
     angle can carry the data that follows.

     Metadata always takes a whole matrix rather than a band. Held static it
     cannot be torn, and a single band's budget is below what it needs. */
  if (g.bootstrap || g.since_meta == 0 || g.since_meta > METADATA_EVERY) {
    if (!g.bootstrap) g.since_meta = 1;
    size_t len = vdtp_stream_metadata(&g.stream);
    vdtp_matrix_encode(&g.layout, g.stream.frame, len, g_cells);
    g_cells_valid = 1;
    return;
  }

  /* One independent frame per band: a capture spanning a screen update loses
     only the band straddling the tear, not everything. */
  g.since_meta++;
  for (int b = 0; b < g.plan.count; b++) {
    size_t len = vdtp_stream_data(&g.stream);
    if (g.ecc) {
      vdtp_ecc_plan bp;
      if (vdtp_ecc_plan_init(&bp, g.plan.bands[b].bytes, VDTP_ECC_REDUNDANCY) != 0) return;
      vdtp_ecc_encode(&bp, g.stream.frame, len, g_bandbuf[b]);
      vdtp_ecc_plan_free(&bp);
    } else {
      memset(g_bandbuf[b], 0, (size_t)g.plan.bands[b].bytes);
      memcpy(g_bandbuf[b], g.stream.frame, len);
    }
  }
  vdtp_encode_bands(&g.layout, &g.plan, g_bandptr, g_cells);
  g_cells_valid = 1;
  g.shown++;
}

static void begin_data_phase(HWND hwnd) {
  if (!g.bootstrap) return;
  g.bootstrap = 0;
  g.since_meta = 0;
  vdtp_stream_rewind(&g.stream);   /* display counters only; the seed climbs on */
  g.shown = 0;
  g.started_ms = GetTickCount();
  advance_frame();
  InvalidateRect(hwnd, NULL, FALSE);
}

/* Back buffer sized to the client area, recreated only when that changes. */
static int ensure_back_buffer(HDC hdc, int w, int h) {
  if (g_back_dc && g_back_w == w && g_back_h == h) return 1;
  if (g_back_dc) {
    SelectObject(g_back_dc, g_back_old);
    DeleteObject(g_back_bmp);
    DeleteDC(g_back_dc);
    g_back_dc = NULL; g_back_bmp = NULL;
  }
  g_back_dc = CreateCompatibleDC(hdc);
  if (!g_back_dc) return 0;
  g_back_bmp = CreateCompatibleBitmap(hdc, w, h);
  if (!g_back_bmp) { DeleteDC(g_back_dc); g_back_dc = NULL; return 0; }
  g_back_old = SelectObject(g_back_dc, g_back_bmp);
  g_back_w = w; g_back_h = h;
  return 1;
}

/*
 * Everything is composed off-screen and blitted once.
 *
 * Painting straight onto the window DC meant filling it white and only then
 * drawing the matrix over it, so the display went blank between the two for as
 * long as the cell loop took. A rolling-shutter camera catches that gap, and a
 * capture containing any band from a different frame is a total loss: there is
 * no intra-frame ECC, so one torn stripe fails the CRC and the whole frame is
 * discarded. That cost nothing during the handshake, where consecutive frames
 * are identical, and everything once real data started moving.
 */
static void paint_stage(HWND hwnd) {
  PAINTSTRUCT ps;
  HDC hdc = BeginPaint(hwnd, &ps);
  RECT rc;
  GetClientRect(hwnd, &rc);
  int w = rc.right, h = rc.bottom;
  if (w <= 0 || h <= 0 || !ensure_back_buffer(hdc, w, h)) { EndPaint(hwnd, &ps); return; }

  HDC target = g_back_dc;
  FillRect(target, &rc, (HBRUSH)GetStockObject(WHITE_BRUSH));
  if (!g.ready || !g_cells_valid) {
    BitBlt(hdc, 0, 0, w, h, target, 0, 0, SRCCOPY);
    EndPaint(hwnd, &ps);
    return;
  }

  int n = g.layout.n;
  /* Integer cell size keeps module edges pixel-crisp; a fractional scale would
     smear them and cost the receiver bits. QUIET cells of margin are reserved
     because the detector rejects frames that touch the image border. */
  int cell = (w < h ? w : h) / (n + 2 * VDTP_QUIET);
  if (cell < 1) cell = 1;
  int side = cell * n;

  ensure_dib(side);
  if (g_pixels) {
    const int top = g.layout.levels - 1;
    const int color = g.layout.levels == 8;
    for (int r = 0; r < n; r++) {
      for (int c = 0; c < n; c++) {
        /* Cell values are levels: 0 darkest, top lightest. At eight the value
           is (R<<2)|(G<<1)|B and each bit drives one channel fully on or off —
           full swing per subpixel, which an LCD switches faster than a grey
           step, and three binary decisions the receiver reads independently. */
        uint32_t value = g_cells[r * n + c], v;
        if (color) {
          v = (((value >> 2) & 1) ? 0x00ff0000u : 0u)
            | (((value >> 1) & 1) ? 0x0000ff00u : 0u)
            | (((value) & 1)      ? 0x000000ffu : 0u);
        } else {
          uint32_t shade = (value * 255) / (uint32_t)top;
          v = (shade << 16) | (shade << 8) | shade;
        }
        for (int y = 0; y < cell; y++) {
          uint32_t *row = g_pixels + (size_t)(r * cell + y) * (size_t)side + (size_t)c * cell;
          for (int x = 0; x < cell; x++) row[x] = v;
        }
      }
    }
    HDC mem = CreateCompatibleDC(target);
    HGDIOBJ old = SelectObject(mem, g_dib);
    BitBlt(target, (w - side) / 2, (h - side) / 2, side, side, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old);
    DeleteDC(mem);
  }

  int K = g.stream.enc.K;
  wchar_t hud[320];
  if (g.bootstrap) {
    swprintf(hud, 320,
             L"握手帧 · %d×%d · %ls · 拖动窗口到目标显示器，接收端读出文件名后按 空格 开始"
             L"   [F11 全屏 · T 置顶 · Esc 退出]",
             g.layout.n, g.layout.n, g.levels == 8 ? L"彩色 3bit" : (g.levels == 4 ? L"四级灰度" : L"黑白"));
  } else {
    double secs = (GetTickCount() - g.started_ms) / 1000.0;
    int pct = K > 0 ? (int)(g.shown * 100 / (uint64_t)K) : 0;
    swprintf(hud, 320,
             L"已播 %llu 帧 · %d×%d · %ls · %.0f s · %.1f KB/s · K=%d · 覆盖 %d%%   [F11 全屏 · Esc 退出]",
             (unsigned long long)g.shown, g.layout.n, g.layout.n,
             g.levels == 8 ? L"彩色 3bit" : (g.levels == 4 ? L"四级灰度" : L"黑白"), secs,
             secs > 0.05 ? (double)g.shown * g.block_size / secs / 1024.0 : 0.0,
             K, pct > 100 ? 100 : pct);
  }
  SetBkMode(target, OPAQUE);
  SetBkColor(target, RGB(255, 255, 255));
  SetTextColor(target, RGB(120, 120, 120));
  TextOutW(target, 12, h - 24, hud, (int)wcslen(hud));

  /* Single blit: the window never shows a partially composed frame. */
  BitBlt(hdc, 0, 0, w, h, target, 0, 0, SRCCOPY);
  EndPaint(hwnd, &ps);
}

/*
 * Standard restore-placement toggle. Sized from the window's *current* monitor
 * rather than SM_CXSCREEN, which reports the primary display — on a multi-head
 * desk the old code always went full screen on the wrong one.
 */
static void toggle_fullscreen(HWND hwnd) {
  DWORD style = (DWORD)GetWindowLongW(hwnd, GWL_STYLE);
  if (!g_fullscreen) {
    MONITORINFO mi;
    mi.cbSize = sizeof(mi);
    if (!GetWindowPlacement(hwnd, &g_prev_placement)) return;
    if (!GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)) return;
    SetWindowLongW(hwnd, GWL_STYLE, (LONG)(style & ~WS_OVERLAPPEDWINDOW));
    SetWindowPos(hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                 mi.rcMonitor.right - mi.rcMonitor.left,
                 mi.rcMonitor.bottom - mi.rcMonitor.top,
                 SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    g_fullscreen = 1;
  } else {
    SetWindowLongW(hwnd, GWL_STYLE, (LONG)(style | WS_OVERLAPPEDWINDOW));
    SetWindowPlacement(hwnd, &g_prev_placement);
    SetWindowPos(hwnd, NULL, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    g_fullscreen = 0;
  }
  InvalidateRect(hwnd, NULL, FALSE);
}

static void toggle_topmost(HWND hwnd) {
  BOOL top = (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
  SetWindowPos(hwnd, top ? HWND_NOTOPMOST : HWND_TOPMOST, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

static void stop_playback(HWND hwnd) {
  KillTimer(hwnd, 1);
  DestroyWindow(hwnd);
}

static LRESULT CALLBACK stage_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_TIMER:
      advance_frame();
      InvalidateRect(hwnd, NULL, FALSE);
      return 0;
    case WM_PAINT:      paint_stage(hwnd); return 0;
    case WM_ERASEBKGND: return 1;

    case WM_SIZE:
      InvalidateRect(hwnd, NULL, FALSE);
      return 0;

    /* Starting is Space/Enter only. The stage is an ordinary window now, so
       clicking it is how you focus or drag it — starting a transfer on click
       would fire every time the window is picked up. */
    case WM_KEYDOWN:
      if (wp == VK_ESCAPE || wp == 'Q') stop_playback(hwnd);
      else if (wp == VK_SPACE || wp == VK_RETURN) begin_data_phase(hwnd);
      else if (wp == VK_F11) toggle_fullscreen(hwnd);
      else if (wp == 'T') toggle_topmost(hwnd);
      return 0;
    case WM_LBUTTONDBLCLK:
      toggle_fullscreen(hwnd);
      return 0;
    case WM_CLOSE:
      stop_playback(hwnd);
      return 0;
    case WM_DESTROY:
      if (g_back_dc) {
        SelectObject(g_back_dc, g_back_old);
        DeleteObject(g_back_bmp);
        DeleteDC(g_back_dc);
        g_back_dc = NULL; g_back_bmp = NULL; g_back_w = g_back_h = 0;
      }
      g_stage = NULL;
      ShowWindow(g_main, SW_SHOW);
      SetForegroundWindow(g_main);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static void start_playback(HINSTANCE inst) {
  if (!g.ready) return;

  /* The stream is left as it is on purpose. Re-initialising would reset the
     fountain seed while keeping the session id, so every frame of a restarted
     run would be a duplicate the receiver already holds — freezing exactly the
     long transfers an operator is most likely to restart. */
  g.shown = 0;
  g.bootstrap = 1;      /* hold on the handshake frame until the operator starts */
  g.since_meta = 0;
  g_cells_valid = 0;
  g.started_ms = GetTickCount();

  /* An ordinary, movable, resizable window: the frame has to be put on
     whichever display the camera is pointed at, and a full-screen popup on the
     primary monitor cannot be moved anywhere. F11 or double-click goes full
     screen on whatever monitor the window is currently on. */
  g_fullscreen = 0;
  int side = GetSystemMetrics(SM_CYSCREEN) * 3 / 4;
  if (side < 480) side = 480;
  g_stage = CreateWindowExW(0, L"VdtpStage", L"VDTP 播放 — F11 全屏 · T 置顶 · 空格 开始",
                            WS_OVERLAPPEDWINDOW,
                            CW_USEDEFAULT, CW_USEDEFAULT, side, side + 40,
                            NULL, NULL, inst, NULL);
  if (!g_stage) { die(L"无法创建播放窗口"); return; }

  ShowWindow(g_main, SW_HIDE);
  ShowWindow(g_stage, SW_SHOW);
  SetForegroundWindow(g_stage);
  SetActiveWindow(g_stage);
  SetFocus(g_stage);            /* without this, Esc never reaches us */

  advance_frame();              /* show something before the first tick */
  SetTimer(g_stage, 1, (UINT)(1000 / FPSES[g.fps_i]), NULL);
}

/* ---------- main window ---------- */

static void set_cycle_labels(void) {
  wchar_t t[64];
  swprintf(t, 64, L"网格 %d×%d", GRIDS[g.grid_i], GRIDS[g.grid_i]);
  SetWindowTextW(g_grid, t);
  swprintf(t, 64, L"%d FPS", FPSES[g.fps_i]);
  SetWindowTextW(g_fps, t);
  SetWindowTextW(g_levels,
                 g.levels == 8 ? L"彩色 3bit" : (g.levels == 4 ? L"四级灰度" : L"黑白"));
}

/* Back to the state the program starts in: no file, no session, and the
   defaults restored. The stream is closed before the buffers it reads from are
   released — it holds pointers into them, not copies. */
static void clear_file(void) {
  close_stream();
  g.ready = 0;
  free(g.data);      g.data = NULL;      g.len = 0;
  free(g.wire);      g.wire = NULL;      g.wire_len = 0;  g.compressed = 0;
  free(g.meta_json); g.meta_json = NULL; g.meta_len = 0;
  free(g_cells);     g_cells = NULL;     g_cells_valid = 0;
  for (int i = 0; i < VDTP_MAX_BANDS; i++) {
    free(g_bandbuf[i]); g_bandbuf[i] = NULL; g_bandptr[i] = NULL;
  }
  g.name_utf8[0] = 0; g.mime[0] = 0; g.sha_hex[0] = 0;
  memset(g.sid, 0, sizeof(g.sid));
  g.session_tag = 0;
  g.block_size = 0; g.since_meta = 0; g.shown = 0; g.bootstrap = 0;
  set_defaults();
  set_cycle_labels();
  refresh_info();
}

static LRESULT CALLBACK main_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_DROPFILES:
      drop_files((HDROP)wp);
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wp)) {
        case ID_PICK:
          pick_file();
          return 0;
        case ID_CLEAR:
          clear_file();
          return 0;
        case ID_GRID:
          g.grid_i = (g.grid_i + 1) % NGRIDS;
          set_cycle_labels();
          if (g.data) build_session();
          refresh_info();
          return 0;
        case ID_FPS:
          g.fps_i = (g.fps_i + 1) % NFPSES;
          set_cycle_labels();
          refresh_info();
          return 0;
        case ID_LEVELS:
          /* Four levels doubles payload at unchanged module size — the right
             lever when the limit is spatial frequency rather than contrast. */
          g.levels = g.levels == 2 ? 4 : (g.levels == 4 ? 8 : 2);
          set_cycle_labels();
          if (g.data) build_session();
          refresh_info();
          return 0;
        case ID_START:
          start_playback((HINSTANCE)GetWindowLongPtrW(hwnd, GWLP_HINSTANCE));
          return 0;
      }
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmd, int show) {
  (void)prev; (void)cmd; (void)show;
  set_defaults();

  WNDCLASSW wc = {0};
  wc.lpfnWndProc = main_proc;
  wc.hInstance = inst;
  wc.lpszClassName = L"VdtpMain";
  wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  RegisterClassW(&wc);

  WNDCLASSW sc = {0};
  sc.lpfnWndProc = stage_proc;
  sc.hInstance = inst;
  sc.lpszClassName = L"VdtpStage";
  sc.hbrBackground = (HBRUSH)GetStockObject(WHITE_BRUSH);
  sc.hCursor = LoadCursor(NULL, IDC_ARROW);
  sc.style = CS_DBLCLKS;   /* required for WM_LBUTTONDBLCLK */
  RegisterClassW(&sc);

  g_main = CreateWindowExW(0, L"VdtpMain", L"VDTP 发送端",
                           WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                           CW_USEDEFAULT, CW_USEDEFAULT, 660, 470, NULL, NULL, inst, NULL);
  if (!g_main) return 1;

  HFONT font = CreateFontW(-14, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                           0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  #define MK(var, cls, text, x, y, w, h, id, style) \
    var = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | (style), x, y, w, h, \
                          g_main, (HMENU)(intptr_t)(id), inst, NULL); \
    SendMessageW(var, WM_SETFONT, (WPARAM)font, TRUE);

  MK(g_pick,  L"BUTTON", L"选择文件…",    16, 16, 108, 30, ID_PICK,  BS_PUSHBUTTON)
  MK(g_grid,  L"BUTTON", L"网格 64×64",  132, 16, 122, 30, ID_GRID,  BS_PUSHBUTTON)
  MK(g_fps,   L"BUTTON", L"10 FPS",       262, 16,  82, 30, ID_FPS,   BS_PUSHBUTTON)
  MK(g_levels, L"BUTTON", L"黑白",         352, 16,  96, 30, ID_LEVELS, BS_PUSHBUTTON)
  MK(g_clear, L"BUTTON", L"清空",         456, 16,  72, 30, ID_CLEAR, BS_PUSHBUTTON)
  MK(g_start, L"BUTTON", L"开始",         536, 16,  92, 30, ID_START, BS_PUSHBUTTON)
  MK(g_info,  L"STATIC", L"",              16, 60, 612, 210, 0, 0)
  MK(g_disclaimer, L"STATIC",
     L"【免责声明】本软件仅供学习与技术研究，按「现状」提供、不含任何担保，"
     L"请勿用于涉密、商业或生产环境。\r\n"
     L"数据以图案在屏幕上明文显示且未加密，任何看到屏幕或拍到画面者均可还原，"
     L"严禁传输涉密或隐私数据；光学信道不保证在任意条件下都能收全，"
     L"不得作为关键数据的唯一传输手段。\r\n"
     L"接收端保存的文件不含病毒扫描，请自行查杀。因使用本软件产生的任何损失、泄密或"
     L"法律后果由使用者自负，并须遵守所在国家和地区的法律法规。\r\n"
     L"完整声明与全部风险项见随附的 NOTICE 与 LICENSE（Apache-2.0）。",
     16, 280, 612, 150, 0, 0)

  /* Accept a file dragged onto the window. The playback stage hides this
     window, so a drop can never land mid-transfer. */
  DragAcceptFiles(g_main, TRUE);

  set_cycle_labels();
  refresh_info();
  ShowWindow(g_main, SW_SHOW);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}

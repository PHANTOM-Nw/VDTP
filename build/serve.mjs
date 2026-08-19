// Minimal static server for dist/.
//
// Exists because the receiver cannot run from file://: Chromium blocks
// getUserMedia there, so the page must be served from a secure context.
// http://localhost counts as one.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const port = Number(process.argv[2] || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const path = join(root, rel === '/' ? 'receiver.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`VDTP receiver:  http://localhost:${port}/receiver.html`);
  console.log(`VDTP sender:    http://localhost:${port}/sender.html`);
  console.log('\nThe receiver needs a secure context for the camera; localhost is one, file:// is not.');
});

#!/usr/bin/env node
// Minimal static file server for local development: node tools/serve.mjs [port]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

http
  .createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (error, content) => {
      if (error) {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      response
        .writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
        .end(content);
    });
  })
  .listen(PORT, () => console.log(`Factorio Calculator running at http://localhost:${PORT}`));

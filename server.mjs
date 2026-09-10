import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { UsageStore } from './usage.mjs';

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const store = new UsageStore();
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  const host = request.headers.host || '';
  if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, service: 'codex-token-monitor', pid: process.pid }));
      return;
    }
    if (url.pathname === '/api/usage') {
      const snapshot = await store.refresh();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(snapshot));
      return;
    }
    const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filename = path.resolve(publicRoot, '.' + requestedPath);
    const relative = path.relative(publicRoot, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative) || requestedPath.includes('\\') || !mimeTypes[path.extname(filename)]) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const content = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)] });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const notFound = error.code === 'ENOENT' || error.code === 'EISDIR';
    response.writeHead(notFound ? 404 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: notFound ? 'Not found' : 'Local usage data could not be loaded. Refresh to retry.' }));
  }
});

const portArg = process.argv.find(arg => arg.startsWith('--port='))?.slice(7);
const requestedPort = Number(portArg || process.env.PORT || 4318);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
  console.error('Port must be an integer between 1024 and 65535.');
  process.exit(1);
}
let port = requestedPort;
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < Math.min(requestedPort + 30, 65535)) {
    port += 1;
    server.listen(port, '127.0.0.1');
  } else {
    console.error('Could not start the local token monitor:', error.code || 'UNKNOWN');
    process.exitCode = 1;
  }
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`CODEX_TOKEN_MONITOR_URL=${url}`);
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
    opener.on('error', () => console.log(`Open this address in your browser: ${url}`));
    opener.unref();
  }
});
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

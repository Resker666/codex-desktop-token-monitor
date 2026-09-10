import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function availablePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  assert.ok(port > 1024);
  return port;
}

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Server startup timed out: ${output}`)), 8000);
    const onExit = code => finish(new Error(`Server exited during startup (${code}): ${output}`));
    const onData = chunk => {
      output += chunk;
      const match = output.match(/CODEX_TOKEN_MONITOR_URL=http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, Number(match[1]));
    };
    const finish = (error, port) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', finish);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      if (error) reject(error);
      else resolve(port);
    };
    child.on('exit', onExit);
    child.on('error', finish);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function stopServer(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const force = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await exited; }
  finally { clearTimeout(force); }
}

test('local server serves synthetic usage and rejects unsafe requests', { timeout: 20000 }, async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-token-server-'));
  let child;
  try {
    await mkdir(path.join(fixtureRoot, 'sessions'));
    await mkdir(path.join(fixtureRoot, 'archived_sessions'));
    const timestamp = new Date().toISOString();
    const counters = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
    const rows = [
      { type: 'session_meta', timestamp, payload: { id: 'synthetic-desktop', originator: 'Codex Desktop', timestamp } },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: counters, last_token_usage: counters } } },
    ];
    const contents = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(path.join(fixtureRoot, 'sessions', 'fixture.jsonl'), contents);
    await writeFile(path.join(fixtureRoot, 'archived_sessions', 'fixture-copy.jsonl'), contents);
    const privateFile = path.join(fixtureRoot, 'private.js');
    await writeFile(privateFile, 'synthetic-secret-must-not-be-served');
    child = spawn(process.execPath, [path.join(projectRoot, 'server.mjs'), `--port=${await availablePort()}`], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HOME: fixtureRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const port = await waitForStartup(child);

    const health = await request(port, '/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, service: 'codex-token-monitor', pid: child.pid });

    const usage = await request(port, '/api/usage');
    assert.equal(usage.status, 200);
    assert.match(usage.headers['content-type'], /^application\/json/);
    const snapshot = JSON.parse(usage.body);
    assert.equal(snapshot.totals.total, 120);
    assert.equal(snapshot.totals.input, 100);
    assert.equal(snapshot.totals.output, 20);
    assert.equal(snapshot.totals.cached, 40);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].id, 'synthetic-desktop');
    assert.equal(snapshot.coverage.files, 2);

    const index = await request(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /^text\/html/);
    assert.match(index.body, /<!doctype html>/i);
    assert.match(index.body, /<script[^>]+src=/);
    assert.equal(index.headers['cache-control'], 'no-store');
    assert.equal(index.headers['x-content-type-options'], 'nosniff');

    const head = await request(port, '/api/usage', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const post = await request(port, '/api/usage', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal((await request(port, '/api/usage', { headers: { Host: 'example.com' } })).status, 403);

    // Encode separators too, so URL normalization cannot remove the traversal before the server sees it.
    const outside = path.relative(path.join(projectRoot, 'public'), privateFile).split(path.sep).join('/');
    const traversal = await request(port, '/' + encodeURIComponent(outside));
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(traversal.body, /synthetic-secret/);
    assert.equal((await request(port, '/%2e%2e%5cserver.mjs')).status, 404);

    const external = Object.values(os.networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal);
    await t.test('does not accept connections on a non-loopback address', { skip: !external, timeout: 4000 }, async () => {
      await assert.rejects(new Promise((resolve, reject) => {
        const socket = net.connect({ host: external.address, port });
        socket.setTimeout(2500, () => socket.destroy(new Error('Connection timed out')));
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      }), { code: 'ECONNREFUSED' });
    });
  } finally {
    if (child) await stopServer(child);
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

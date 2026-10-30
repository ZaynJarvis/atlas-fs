// Standalone Atlas Studio server: serves dist/ and an allowlisted, read-only OpenViking proxy.
// The API key is read from ovcli.conf (OVCLI_CONF, default ~/.openviking/ovcli.conf) and never
// leaves this process. Usage: HOST=0.0.0.0 PORT=8790 node server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { forward, InputError, loadConnection, parseHttpUrl, publicView, saveConnection } from './server/openviking.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4380);
const CONF = process.env.OVCLI_CONF || join(homedir(), '.openviking', 'ovcli.conf');
const DATA_DIR = process.env.DATA_DIR || join(homedir(), '.config', 'openviking-studio-web');
const DIST = join(import.meta.dirname, 'dist');
const API = '/ov-api';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

// Saved connection (DATA_DIR/connection.json, mode 0600) wins; ovcli.conf is only an initial default.
async function connection() {
  const saved = await loadConnection(DATA_DIR);
  if (saved.baseUrl) return saved;
  try {
    const raw = JSON.parse(await readFile(CONF, 'utf8'));
    return { baseUrl: String(raw.url || '').replace(/\/+$/, ''), apiKey: raw.api_key || '', account: raw.account || '', user: raw.user || '', studioUrl: '' };
  } catch {
    return saved;
  }
}

async function testConnection(c) {
  if (!c.baseUrl) return { ok: false, error: 'No server URL configured.' };
  try {
    const health = await forward(c, { method: 'GET', path: '/health', query: new URLSearchParams() });
    if (health.status === 401 || health.status === 403) return { ok: false, error: `Server reachable, but the API key was rejected (HTTP ${health.status}).` };
    if (health.status >= 400) return { ok: false, error: `Health check failed: HTTP ${health.status}` };
    const ls = await forward(c, { method: 'GET', path: '/api/v1/fs/ls', query: new URLSearchParams({ uri: 'viking://' }) });
    if (ls.status === 401 || ls.status === 403) return { ok: false, error: `Server reachable, but the API key was rejected (HTTP ${ls.status}).` };
    if (ls.status >= 400) return { ok: false, error: `Server reachable, but listing failed: HTTP ${ls.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Cannot reach ${c.baseUrl}: ${e?.cause?.code || e?.cause?.cause?.code || e?.cause?.message || e?.message || 'network error'}` };
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1 << 20) { reject(new InputError('body_too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://atlas.local');
  try {
    if (url.pathname.startsWith(`${API}/`)) {
      const method = req.method || 'GET';
      const body = method === 'POST' ? await readBody(req) : undefined;
      const out = await forward(await connection(), { method, path: url.pathname.slice(API.length), query: url.searchParams, body });
      res.writeHead(out.status, out.headers);
      return res.end(out.body);
    }
    if (url.pathname === '/ov/connection' && req.method === 'GET') return json(res, 200, publicView(await connection()));
    if (url.pathname === '/ov/connection' && req.method === 'PUT') {
      const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const current = await connection();
      // Seed from the effective connection so a key that came from ovcli.conf is kept unless replaced.
      if (!(await loadConnection(DATA_DIR)).baseUrl && current.apiKey) await saveConnection(DATA_DIR, { ...current, baseUrl: current.baseUrl || patch.baseUrl });
      const saved = await saveConnection(DATA_DIR, patch);
      return json(res, 200, publicView(saved));
    }
    if (url.pathname === '/ov/test' && req.method === 'POST') {
      // Test the submitted values (falling back to the stored key) without saving them.
      const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const current = await connection();
      const c = { ...current, baseUrl: patch.baseUrl ? parseHttpUrl(patch.baseUrl, 'baseUrl') : current.baseUrl,
        account: patch.account ?? current.account, user: patch.user ?? current.user,
        apiKey: patch.apiKey ? String(patch.apiKey).trim().replace(/^bearer\s+/i, '') : current.apiKey };
      return json(res, 200, await testConnection(c));
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (rel.startsWith('..')) return json(res, 404, { error: 'not_found' });
    let file = join(DIST, rel || 'index.html');
    if (!(await stat(file).catch(() => null))?.isFile()) file = join(DIST, 'index.html');
    const type = TYPES[extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
    });
    res.end(await readFile(file));
  } catch (error) {
    if (error instanceof InputError) return json(res, error.message === 'route_not_allowed' ? 404 : 400, { error: error.message });
    process.stderr.write(`request_failed ${req.method} ${url.pathname} ${error?.name}\n`);
    return json(res, 502, { error: 'openviking_unavailable' });
  }
});
server.listen(PORT, HOST, () => process.stderr.write(`Atlas Studio on http://${HOST}:${PORT}/\n`));

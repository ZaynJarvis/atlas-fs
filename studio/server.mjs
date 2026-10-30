// Standalone Atlas Studio server: serves dist/ and an allowlisted, read-only OpenViking proxy.
// The API key is read from ovcli.conf (OVCLI_CONF, default ~/.openviking/ovcli.conf) and never
// leaves this process. Usage: HOST=0.0.0.0 PORT=8790 node server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { forward, InputError, publicView } from './server/openviking.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4380);
const CONF = process.env.OVCLI_CONF || join(homedir(), '.openviking', 'ovcli.conf');
const DIST = join(import.meta.dirname, 'dist');
const API = '/ov-api';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

async function connection() {
  const raw = JSON.parse(await readFile(CONF, 'utf8'));
  return {
    baseUrl: String(raw.url || '').replace(/\/+$/, ''),
    apiKey: raw.api_key || '',
    account: raw.account || process.env.OV_ACCOUNT || '',
    user: raw.user || process.env.OV_USER || '',
    studioUrl: '',
  };
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

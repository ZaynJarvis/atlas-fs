/**
 * OpenViking read-only HTTP adapter.
 *
 * Implements the FileSystem contract (see fs-api.js) on top of the
 * OpenViking REST API. Read-only: only GET endpoints are used.
 *
 * Base URL example:  http://localhost:1933
 * Auth:              X-API-Key header (optional in dev/no-auth mode)
 *
 * Endpoints used (from OpenViking docs, /api/v1/...):
 *   GET  /health                                 — connectivity probe
 *   GET  /api/v1/fs/ls?uri=...&recursive=&simple=
 *   GET  /api/v1/fs/read?uri=...                 — file contents
 *   GET  /api/v1/fs/stat?uri=...                 — metadata (best-effort)
 *   POST /api/v1/search/find                     — semantic search
 *
 * Path convention in our app: POSIX paths like "/resources/my_project/docs"
 * map to URIs like "viking://resources/my_project/docs/".
 */

(function () {
  const { FileSystem, FsError, Path, detectMime } = window.FS;

  const VIKING_PROTOCOL = 'viking://';

  // path "/" -> "viking://"
  // path "/resources" -> "viking://resources/"
  // path "/resources/foo/bar.md" -> "viking://resources/foo/bar.md"
  function pathToUri(path) {
    path = Path.normalize(path);
    if (path === '/') return VIKING_PROTOCOL;
    return VIKING_PROTOCOL + path.slice(1);
  }
  function uriToPath(uri) {
    if (!uri) return '/';
    if (!uri.startsWith(VIKING_PROTOCOL)) return uri.startsWith('/') ? uri : '/' + uri;
    let rest = uri.slice(VIKING_PROTOCOL.length);
    if (rest.endsWith('/')) rest = rest.slice(0, -1);
    return rest ? '/' + rest : '/';
  }

  function mapStatusToErrCode(status) {
    if (status === 404) return 'ENOENT';
    if (status === 403 || status === 401) return 'EACCES';
    if (status === 400) return 'EINVAL';
    return 'EIO';
  }

  class OpenVikingFs extends FileSystem {
    /**
     * @param {object} opts
     * @param {string} opts.url       - base URL, e.g. "http://localhost:1933"
     * @param {string} [opts.apiKey]  - X-API-Key value
     * @param {string} [opts.account] - X-OpenViking-Account (multi-tenant)
     * @param {string} [opts.user]    - X-OpenViking-User    (multi-tenant)
     * @param {number} [opts.timeoutMs=15000]
     */
    constructor(opts = {}) {
      super();
      this.url = (opts.url || '').replace(/\/$/, '');
      this.apiKey = opts.apiKey || '';
      this.account = opts.account || '';
      this.user = opts.user || '';
      this.timeoutMs = opts.timeoutMs ?? 15000;
      this._listCache = new Map();   // path -> {entries, expires}
      this._statCache = new Map();
    }

    _headers(extra = {}) {
      const h = { 'Accept': 'application/json', ...extra };
      if (this.apiKey) h['X-API-Key'] = this.apiKey;
      if (this.account) h['X-OpenViking-Account'] = this.account;
      if (this.user) h['X-OpenViking-User'] = this.user;
      return h;
    }

    async _req(pathOrUrl, init = {}) {
      const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.url + pathOrUrl;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          ...init,
          headers: this._headers(init.headers),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        throw new FsError('EIO', `Network error: ${e.message}`, pathOrUrl);
      }
      clearTimeout(timer);
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch {}
        throw new FsError(mapStatusToErrCode(res.status), `${res.status} ${res.statusText}: ${body.slice(0, 200)}`, pathOrUrl);
      }
      return res;
    }

    async ping() {
      const res = await this._req('/health');
      return await res.json().catch(() => ({ status: 'ok' }));
    }

    /**
     * List a directory.
     * OpenViking response shape (per docs):
     *   { status: 'ok', result: [{ name, isDir, uri, size?, mtime? }, ...] }
     * Some servers return { entries: [...] }. We accept both.
     */
    async list(path, opts = {}) {
      const cached = this._listCache.get(path);
      if (cached && cached.expires > Date.now()) return this._applyOpts(cached.entries, opts);
      const uri = pathToUri(path) + (path.endsWith('/') || path === '/' ? '' : '/');
      const url = `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`;
      const res = await this._req(url);
      const data = await res.json();
      const raw = data.result || data.entries || data || [];
      const entries = (Array.isArray(raw) ? raw : []).map((e) => this._normalize(e, path));
      this._listCache.set(path, { entries, expires: Date.now() + 5000 });
      // also opportunistically populate stat cache
      for (const e of entries) this._statCache.set(e.path, { value: e, expires: Date.now() + 5000 });
      return this._applyOpts(entries, opts);
    }

    _applyOpts(entries, opts = {}) {
      const { includeHidden = true, sortBy = 'name', sortDir = 'asc' } = opts;
      let out = entries.slice();
      if (!includeHidden) out = out.filter((e) => !e.hidden);
      out.sort((a, b) => {
        if (a.type !== b.type) {
          if (a.type === 'directory') return -1;
          if (b.type === 'directory') return 1;
        }
        let cmp = 0;
        if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
        else if (sortBy === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0);
        else if (sortBy === 'type') cmp = (a.language || a.mime || '').localeCompare(b.language || b.mime || '');
        else cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
        return sortDir === 'desc' ? -cmp : cmp;
      });
      return out;
    }

    _normalize(entry, parentPath) {
      // Defensive — different OpenViking versions emit slightly different fields.
      const name = entry.name ?? Path.basename(uriToPath(entry.uri || entry.path || ''));
      const isDir = entry.isDir ?? entry.is_dir ?? entry.type === 'directory';
      const path = entry.uri ? uriToPath(entry.uri) : Path.join(parentPath, name);
      const det = detectMime(name);
      const mtime = entry.mtime ? (typeof entry.mtime === 'number' ? entry.mtime : Date.parse(entry.mtime)) : 0;
      return {
        path,
        name,
        type: isDir ? 'directory' : 'file',
        size: entry.size ?? 0,
        mtime: mtime || 0,
        ctime: entry.ctime ? Date.parse(entry.ctime) || 0 : (mtime || 0),
        mode: entry.mode ?? (isDir ? 0o555 : 0o444),  // read-only bits
        mime: entry.mime || det.mime,
        language: entry.language || det.language,
        hidden: name.startsWith('.') || name.startsWith('_'),
      };
    }

    async stat(path) {
      const cached = this._statCache.get(path);
      if (cached && cached.expires > Date.now()) return cached.value;
      // Try /api/v1/fs/stat first (some builds expose it); fall back to listing parent.
      const uri = pathToUri(path);
      try {
        const res = await this._req(`/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`);
        const data = await res.json();
        const raw = data.result || data;
        const norm = this._normalize({ ...raw, name: raw.name || Path.basename(path) || '/' }, Path.dirname(path));
        this._statCache.set(path, { value: norm, expires: Date.now() + 5000 });
        return norm;
      } catch (e) {
        if (e.code !== 'ENOENT' && path !== '/') {
          // Fallback: scan parent directory
          const parent = Path.dirname(path);
          const entries = await this.list(parent).catch(() => []);
          const hit = entries.find((x) => x.path === path);
          if (hit) return hit;
        }
        if (path === '/') {
          // Synthesize root stat
          const root = { path: '/', name: '/', type: 'directory', size: 0, mtime: 0, ctime: 0, mode: 0o555, hidden: false };
          this._statCache.set(path, { value: root, expires: Date.now() + 60000 });
          return root;
        }
        throw e;
      }
    }

    async read(path, opts = {}) {
      const { maxBytes = 256 * 1024, encoding = 'utf-8', level = 'l2' } = opts;
      const uri = pathToUri(path);
      // OpenViking uses /api/v1/content/* for content reads.
      // level: 'l0' (abstract), 'l1' (overview), 'l2' (full content)
      const endpoint = level === 'l0' ? 'abstract' : level === 'l1' ? 'overview' : 'read';
      const res = await this._req(`/api/v1/content/${endpoint}?uri=${encodeURIComponent(uri)}`);
      const ct = res.headers.get('content-type') || '';
      let content = '';
      if (ct.includes('application/json')) {
        const data = await res.json();
        const r = data.result;
        if (typeof r === 'string') content = r;
        else if (r && typeof r === 'object') content = r.content ?? r.text ?? JSON.stringify(r, null, 2);
        else content = data.content ?? '';
      } else {
        content = await res.text();
      }
      const truncated = content.length > maxBytes;
      return {
        content: truncated ? content.slice(0, maxBytes) : content,
        encoding,
        truncated,
      };
    }

    async exists(path) {
      try { await this.stat(path); return true; }
      catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    }

    async search(query, opts = {}) {
      return this.find(query, opts);
    }

    async find(query, opts = {}) {
      const { limit = 50, root = '/' } = opts;
      if (!query) return [];
      const body = { query, limit };
      if (root && root !== '/') body.target_uri = pathToUri(root);
      try {
        const res = await this._req('/api/v1/search/find', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        const r = data.result || {};
        const all = [...(r.resources || []), ...(r.memories || [])];
        return all.map((h) => ({
          path: h.uri ? uriToPath(h.uri) : (h.path || ''),
          name: h.name || Path.basename(h.uri ? uriToPath(h.uri) : (h.path || '')),
          type: h.isDir ? 'directory' : 'file',
          score: h.score ?? 0,
          snippet: h.abstract || h.snippet || null,
          line: null,
        }));
      } catch {
        return [];
      }
    }

    async grep(pattern, opts = {}) {
      const { limit = 200, root = '/' } = opts;
      if (!pattern) return [];
      const uri = pathToUri(root === '/' ? '/' : root);
      const body = { uri, pattern, limit };
      try {
        const res = await this._req('/api/v1/search/grep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        const matches = (data.result && data.result.matches) || [];
        return matches.map((m) => ({
          uri: uriToPath(m.uri),
          line: m.line,
          content: m.content,
        }));
      } catch {
        return [];
      }
    }

    async glob(pattern, opts = {}) {
      const { limit = 500, root = '/' } = opts;
      if (!pattern) return [];
      const uri = pathToUri(root === '/' ? '/' : root);
      const body = { uri, pattern, limit };
      try {
        const res = await this._req('/api/v1/search/glob', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        const matches = (data.result && data.result.matches) || [];
        return matches.map((u) => {
          const cleaned = u.startsWith('viking:/') && !u.startsWith('viking://')
            ? 'viking://' + u.slice('viking:/'.length)
            : u;
          return uriToPath(cleaned);
        });
      } catch {
        return [];
      }
    }

    async resolve(path) { return Path.normalize(path); }

    invalidate() {
      this._listCache.clear();
      this._statCache.clear();
    }
  }

  window.FS.OpenVikingFs = OpenVikingFs;
  window.FS.uriToPath = uriToPath;
  window.FS.pathToUri = pathToUri;
})();

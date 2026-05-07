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

  function truthyFlag(value) {
    return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
  }

  function isDirectoryEntry(entry) {
    const type = String(entry.type || entry.kind || entry.nodeType || '').toLowerCase();
    const uri = entry.uri || entry.path || '';
    return truthyFlag(entry.isDir)
      || truthyFlag(entry.is_dir)
      || truthyFlag(entry.isdir)
      || type === 'directory'
      || type === 'dir'
      || type === 'folder'
      || uri.endsWith('/');
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
      this._listCache = new Map();
      this._statCache = new Map();
      this._dropPersistedListCache();
    }

    _lsKey() { return 'atlas-fs-cache:' + this.url; }

    _dropPersistedListCache() {
      try { localStorage.removeItem(this._lsKey()); } catch {}
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
      const refresh = truthyFlag(opts.refresh) || truthyFlag(opts.forceRefresh) || truthyFlag(opts.noCache);
      const cached = this._listCache.get(path);
      if (!refresh && cached && cached.expires > Date.now()) return this._applyOpts(cached.entries, opts);
      const uri = pathToUri(path) + (path.endsWith('/') || path === '/' ? '' : '/');
      const url = `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`;
      const res = await this._req(url, refresh ? { cache: 'no-store' } : {});
      const data = await res.json();
      const raw = data.result || data.entries || data || [];
      const entries = (Array.isArray(raw) ? raw : []).map((e) => this._normalize(e, path));
      this._listCache.set(path, { entries, expires: Date.now() + 5000 });
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
      const isDir = isDirectoryEntry(entry);
      const path = entry.uri ? uriToPath(entry.uri) : Path.join(parentPath, name);
      const det = detectMime(name);
      const rawMtime = entry.mtime || entry.modTime;
      let mtime = 0;
      if (rawMtime) {
        if (typeof rawMtime === 'number') mtime = rawMtime;
        else {
          const s = rawMtime.trim();
          if (/^\d{1,2}:\d{2}/.test(s)) {
            const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
            mtime = Date.parse(today + 'T' + s + '+08:00') || 0;
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            mtime = Date.parse(s + 'T00:00:00+08:00') || 0;
          } else {
            const parsed = Date.parse(s);
            if (!isNaN(parsed)) mtime = parsed;
          }
        }
      }
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
      if (path === '/') {
        const root = { path: '/', name: '/', type: 'directory', size: 0, mtime: 0, ctime: 0, mode: 0o555, hidden: false };
        this._statCache.set(path, { value: root, expires: Date.now() + 60000 });
        return root;
      }

      // Avoid probing /api/v1/fs/stat because some OpenViking deployments return
      // 400 for valid paths. Parent listings already contain enough metadata.
      const parent = Path.dirname(path);
      const entries = await this.list(parent).catch(() => []);
      const hit = entries.find((x) => x.path === path);
      if (hit) return hit;
      throw new FsError('ENOENT', 'Not found: ' + path, path);
    }

    async read(path, opts = {}) {
      const { maxBytes = 256 * 1024, encoding = 'utf-8', level = 'l2', isDirectory = false } = opts;
      let uri = pathToUri(path);
      if (isDirectory && uri !== VIKING_PROTOCOL && !uri.endsWith('/')) uri += '/';
      // OpenViking uses /api/v1/content/* for content reads.
      // level: 'l0' (abstract), 'l1' (overview), 'l2' (full content)
      const endpoint = level === 'l0' ? 'abstract' : level === 'l1' ? 'overview' : 'read';
      const res = await this._req(`/api/v1/content/${endpoint}?uri=${encodeURIComponent(uri)}`, { cache: 'no-store' });
      const ct = res.headers.get('content-type') || '';
      let content = '';
      if (ct.includes('application/json')) {
        const data = await res.json();
        const r = data.result;
        if (typeof r === 'string') content = r;
        else if (r && typeof r === 'object') {
          content = r.content ?? r.text ?? r.markdown ?? r.abstract ?? r.overview ?? r.summary ?? JSON.stringify(r, null, 2);
        } else {
          content = data.content ?? data.text ?? data.markdown ?? data.abstract ?? data.overview ?? data.summary ?? '';
        }
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
      const localFindFile = async (path) => {
        const r = await this.read(path);
        const q = query.toLowerCase();
        const out = [];
        const lines = (r.content || '').split('\n');
        for (let i = 0; i < lines.length && out.length < limit; i++) {
          const line = lines[i];
          if (!line.toLowerCase().includes(q)) continue;
          out.push({
            path,
            name: Path.basename(path),
            type: 'file',
            score: 1,
            snippet: line.trim().slice(0, 240),
            line: i + 1,
          });
        }
        return out;
      };
      const stat = await this.stat(root).catch(() => null);
      if (stat?.type === 'file') {
        const local = await localFindFile(root).catch(() => []);
        if (local.length) return local;
      }
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
        const out = all.map((h) => ({
          path: h.uri ? uriToPath(h.uri) : (h.path || ''),
          name: h.name || Path.basename(h.uri ? uriToPath(h.uri) : (h.path || '')),
          type: isDirectoryEntry(h) ? 'directory' : 'file',
          score: h.score ?? 0,
          snippet: h.abstract || h.snippet || null,
          line: null,
        }));
        if (!out.length && root !== '/' && Path.extname(root)) {
          const local = await localFindFile(root).catch(() => []);
          if (local.length) return local;
        }
        return out;
      } catch {
        return [];
      }
    }

    async grep(pattern, opts = {}) {
      const { limit = 200, root = '/', ignoreCase = false } = opts;
      if (!pattern) return [];
      const localGrepFile = async (path) => {
        let re;
        try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); }
        catch (e) { throw new FsError('EINVAL', 'Bad regex: ' + e.message, path); }
        const r = await this.read(path);
        const lines = (r.content || '').split('\n');
        const out = [];
        for (let i = 0; i < lines.length && out.length < limit; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) out.push({ uri: path, line: i + 1, content: lines[i] });
        }
        return out;
      };

      const stat = await this.stat(root).catch(() => null);
      if (stat?.type === 'file') return localGrepFile(root);

      const uri = pathToUri(root === '/' ? '/' : root);
      const body = { uri, pattern, limit };
      try {
        const res = await this._req('/api/v1/search/grep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        const result = data.result || {};
        const matches = result.matches || [];
        const out = matches.map((m) => ({
          uri: uriToPath(m.uri),
          line: m.line,
          content: m.content,
        }));
        if (!out.length && root !== '/' && result.files_scanned === 0) {
          const local = await localGrepFile(root).catch(() => null);
          if (local) return local;
        }
        return out;
      } catch (e) {
        throw e;
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

/**
 * Mock developer repo dataset. Plug into InMemoryFs.
 * Deep multi-level structure to make Columns navigation meaningful.
 */
(function () {
  const day = 24 * 60 * 60 * 1000;
  const NOW = Date.now();
  const t = (daysAgo, hours = 0) => NOW - daysAgo * day - hours * 60 * 60 * 1000;

  // ---------- file content snippets ----------
  const README = `# Atlas

A read-only filesystem navigator playground.

## Overview

Atlas is a study in filesystem UX. It ships five distinct navigation paradigms
on top of a single, stable read-only API surface (\`window.FS\`). Swap the
in-memory adapter for any backend — Browser FS Access, HTTP, ZIP — and every
view continues to work unchanged.

## Quick start

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

## Paradigms

1. **Columns** — Miller / NeXT browser. Drill left-to-right, see ancestry.
2. **Tree** — Classic two-pane explorer. Hierarchical sidebar + detail.
3. **Spatial** — Icon grid. Each folder is a "place".
4. **Command** — Keyboard-first fuzzy palette. Zero mouse.
5. **Table** — Breadcrumb + dense data table. Information per pixel.

## License

MIT.
`;

  const ROUTES_TS = `import { Router } from 'express';
import { listDir, readFile } from '../fs/adapter';

export const fs = Router();

fs.get('/list', async (req, res) => {
  const path = String(req.query.path ?? '/');
  try {
    const entries = await listDir(path);
    res.json({ path, entries });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

fs.get('/read', async (req, res) => {
  const path = String(req.query.path ?? '');
  const data = await readFile(path);
  res.type(data.mime).send(data.content);
});
`;

  const ADAPTER_TS = `// Read-only FS adapter — server side.
// Mirrors the contract in /docs/fs-api.md exactly.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectMime } from './mime';

const ROOT = process.env.FS_ROOT ?? process.cwd();

function safe(p: string) {
  const abs = path.resolve(ROOT, '.' + p);
  if (!abs.startsWith(ROOT)) throw new Error('EACCES');
  return abs;
}

export async function stat(p: string) {
  const s = await fs.stat(safe(p));
  return {
    path: p,
    name: path.basename(p),
    type: s.isDirectory() ? 'directory' : 'file',
    size: s.size,
    mtime: s.mtimeMs,
    mode: s.mode,
  };
}

export async function listDir(p: string) {
  const dir = safe(p);
  const items = await fs.readdir(dir, { withFileTypes: true });
  return items.map((d) => ({
    name: d.name,
    type: d.isDirectory() ? 'directory' : 'file',
    path: path.posix.join(p, d.name),
  }));
}

export async function readFile(p: string) {
  const buf = await fs.readFile(safe(p));
  return { content: buf.toString('utf-8'), mime: detectMime(p) };
}
`;

  const APP_TSX = `import { useState } from 'react';
import { FsProvider } from './fs/context';
import { Columns } from './views/columns/Columns';
import { Tree } from './views/tree/Tree';
import { Spatial } from './views/spatial/Spatial';
import { Command } from './views/command/Command';
import { Table } from './views/table/Table';

const VIEWS = { columns: Columns, tree: Tree, spatial: Spatial, command: Command, table: Table };

export default function App() {
  const [view, setView] = useState<keyof typeof VIEWS>('columns');
  const Active = VIEWS[view];
  return (
    <FsProvider>
      <header>
        {Object.keys(VIEWS).map((k) => (
          <button key={k} onClick={() => setView(k as any)} aria-pressed={view === k}>{k}</button>
        ))}
      </header>
      <main><Active /></main>
    </FsProvider>
  );
}
`;

  const PKG_JSON = `{
  "name": "atlas",
  "version": "0.4.2",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "express": "^4.19.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.5.0"
  }
}
`;

  const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
`;

  const FS_API_MD = `# FS API contract

The read-only filesystem API has six methods:

| Method      | Returns        | Description                              |
|-------------|----------------|------------------------------------------|
| \`stat\`      | \`Stat\`         | Metadata for one path                    |
| \`list\`      | \`DirEntry[]\`   | Children of a directory                  |
| \`read\`      | \`FileChunk\`    | UTF-8 contents (truncated if large)      |
| \`exists\`    | \`boolean\`      | Cheap existence check                    |
| \`search\`    | \`SearchHit[]\`  | Fuzzy name + (optional) content search   |
| \`resolve\`   | \`string\`       | Canonicalize, follow symlinks            |

All paths POSIX, all methods async, all errors throw \`FsError\` with codes
\`ENOENT | ENOTDIR | EISDIR | EACCES | EINVAL | EIO\`.

The interface is **deliberately small**. Any backend that can answer these six
questions can serve every view in the product.
`;

  const COLUMNS_TSX = `// Miller-columns view. Drill left to right.
// Reads only \`fs.list(path)\` per visible column. No state outside the trail.

import { useEffect, useState } from 'react';
import { useFs } from '../../fs/context';
import { Column } from './Column';

export function Columns() {
  const fs = useFs();
  const [trail, setTrail] = useState<string[]>(['/']);
  const [columns, setColumns] = useState<Record<string, any[]>>({});

  useEffect(() => {
    Promise.all(trail.map((p) => fs.list(p))).then((cols) => {
      const next: Record<string, any[]> = {};
      trail.forEach((p, i) => (next[p] = cols[i]));
      setColumns(next);
    });
  }, [trail.join('|')]);

  return (
    <div className="columns">
      {trail.map((path, i) => (
        <Column
          key={path}
          path={path}
          entries={columns[path] ?? []}
          selected={trail[i + 1]}
          onPick={(p) => setTrail([...trail.slice(0, i + 1), p])}
        />
      ))}
    </div>
  );
}
`;

  const SEARCH_PY = `"""Search index builder.

Reads files via the read-only FS adapter, builds a small inverted index in
SQLite. Designed to plug into any FileSystem implementation.
"""

import sqlite3
from pathlib import Path
from typing import Iterator

DB_PATH = Path(".atlas/index.db")


def build(fs) -> None:
    db = sqlite3.connect(DB_PATH)
    db.executescript("""
        DROP TABLE IF EXISTS docs;
        CREATE VIRTUAL TABLE docs USING fts5(path, content);
    """)
    for entry in walk(fs, "/"):
        if entry["type"] != "file":
            continue
        chunk = fs.read(entry["path"])
        db.execute("INSERT INTO docs(path, content) VALUES (?, ?)",
                   (entry["path"], chunk["content"]))
    db.commit()


def walk(fs, root: str) -> Iterator[dict]:
    stack = [root]
    while stack:
        p = stack.pop()
        for e in fs.list(p):
            yield e
            if e["type"] == "directory":
                stack.append(e["path"])
`;

  const STYLES_CSS = `:root {
  --bg: #fafaf7;
  --ink: #1a1a17;
  --muted: #6b6a64;
  --line: #e8e6df;
  --accent: #b8482e;
  --serif: 'Source Serif 4', Georgia, serif;
  --sans: 'Inter', system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, monospace;
}

* { box-sizing: border-box; }

body {
  font-family: var(--sans);
  color: var(--ink);
  background: var(--bg);
  margin: 0;
}
`;

  const TOKENS_CSS = `/* Design tokens. Single source of truth for color, type, spacing. */
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --radius-sm: 4px;
  --radius-md: 8px;
}
`;

  const CHANGELOG = `# Changelog

## 0.4.2 — 2026-04-28
- Spatial view: fix focus ring on grid items
- Table view: persist sort order in URL

## 0.4.1 — 2026-04-15
- New: command palette (\`cmd-k\`)
- Search now runs against an FTS5 index when available

## 0.4.0 — 2026-03-30
- Five-paradigm refactor — every view now reads through one stable contract
- Drop legacy \`fs.legacyList()\`

## 0.3.0 — 2026-02-12
- Initial public release
`;

  const GITIGNORE = `node_modules/
dist/
.atlas/
.env
.env.local
*.log
.DS_Store
`;

  const ENV_EXAMPLE = `FS_ROOT=/var/data/repo
PORT=4000
LOG_LEVEL=info
`;

  const TODO_MD = `# TODO

- [ ] Symlink loop detection in InMemoryFs.walk
- [ ] Replace ad-hoc fuzzy scorer with sublime-style char-class scoring
- [ ] Spatial view: pinch-to-zoom on trackpad
- [x] Lift selection state out of Tree view
- [x] Document FS contract in /docs/fs-api.md
`;

  const LICENSE = `MIT License

Copyright (c) 2026 Atlas contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software...
`;

  // helpers
  const f = (name, content, daysAgo = 5, hours = 0) => ({ type: 'file', name, content, mtime: t(daysAgo, hours) });
  const d = (name, children, daysAgo = 5, opts = {}) => ({ type: 'directory', name, children, mtime: t(daysAgo), ...opts });
  const stub = (name, lines = 30, daysAgo = 10) => f(name, `// ${name}\n// Auto-generated stub for navigation testing.\n\n` + Array.from({length: lines}, (_, i) => `export const item${i} = { id: ${i}, name: "${name}-${i}" };`).join('\n'), daysAgo);

  const data = [
    // root files
    f('README.md', README, 2),
    f('CHANGELOG.md', CHANGELOG, 8),
    f('LICENSE', LICENSE, 200),
    f('package.json', PKG_JSON, 3),
    f('tsconfig.json', TSCONFIG, 20),
    f('.gitignore', GITIGNORE, 60),
    f('.env.example', ENV_EXAMPLE, 40),
    f('TODO.md', TODO_MD, 1, 4),

    // ============ src ============
    d('src', [
      f('App.tsx', APP_TSX, 0, 3),
      f('main.tsx', `import { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './styles/global.css';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`, 5),

      d('fs', [
        f('context.tsx', `import { createContext, useContext } from 'react';\nimport { fs as defaultFs } from './adapter';\nexport const FsContext = createContext(defaultFs);\nexport const useFs = () => useContext(FsContext);\n`, 4),
        f('adapter.ts', ADAPTER_TS, 0, 6),
        f('mime.ts', `// Maps extensions to (mime, language). Tiny on purpose.\nconst T: Record<string, [string, string?]> = {\n  '.md': ['text/markdown', 'markdown'],\n  '.ts': ['text/typescript', 'typescript'],\n  '.tsx': ['text/tsx', 'tsx'],\n  '.json': ['application/json', 'json'],\n};\nexport function detectMime(p: string) {\n  const i = p.lastIndexOf('.');\n  return T[p.slice(i)]?.[0] ?? 'application/octet-stream';\n}\n`, 15),
        f('errors.ts', `export class FsError extends Error {\n  constructor(public code: string, message: string, public path?: string) { super(message); }\n}\n`, 20),
        f('path.ts', `// POSIX path helpers — pure, no dependencies.\nexport const Path = {\n  sep: '/',\n  normalize(p: string): string { /* ... */ return p; },\n  join(...parts: string[]): string { return parts.join('/'); },\n  dirname(p: string): string { return p.slice(0, p.lastIndexOf('/')) || '/'; },\n  basename(p: string): string { return p.slice(p.lastIndexOf('/') + 1); },\n};\n`, 18),
        d('adapters', [
          f('in-memory.ts', `// Pure JS in-memory implementation of FileSystem.\nimport { FileSystem } from '../types';\nexport class InMemoryFs implements FileSystem { /* ... */ }\n`, 9),
          f('http.ts', `// HTTP-backed adapter. Talks to /api/fs/* on the configured host.\nimport { FileSystem } from '../types';\nexport class HttpFs implements FileSystem {\n  constructor(private baseUrl: string) {}\n  async list(p: string) { return fetch(this.baseUrl + '/list?path=' + p).then(r => r.json()); }\n}\n`, 12),
          f('zip.ts', `// Read a .zip archive as a virtual filesystem.\nimport { FileSystem } from '../types';\nexport class ZipFs implements FileSystem { /* unzipit-based */ }\n`, 22),
          f('fs-access.ts', `// Browser File System Access API adapter.\n// User picks a directory; we mount it read-only.\nexport async function mount() {\n  const handle = await (window as any).showDirectoryPicker({ mode: 'read' });\n  return new DirectoryAdapter(handle);\n}\n`, 7),
        ], 8),
        d('search', [
          f('fuzzy.ts', `// Sublime Text-style fuzzy scorer.\n// Higher scores for: prefix, camel-hump, word-boundary, contiguous match.\nexport function score(query: string, target: string): number { /* ... */ return 0; }\n`, 13),
          f('fts5.ts', `// SQLite FTS5 wrapper (via sql.js in browser, sqlite3 on server).\nexport class Fts5Index { /* ... */ }\n`, 16),
          f('index.ts', `export * from './fuzzy';\nexport * from './fts5';\n`, 16),
        ], 13),
      ], 4),

      d('views', [
        d('columns', [
          f('Columns.tsx', COLUMNS_TSX, 0, 1),
          f('Column.tsx', `// One column in the Miller stack.\nexport function Column({ path, entries, selected, onPick }) { return null; }\n`, 0, 2),
          f('useTrail.ts', `// Manages the current path trail. Backed by URL history.\nexport function useTrail() { /* ... */ }\n`, 1),
          f('Columns.css', `.columns { display: flex; overflow-x: auto; }\n.col { flex: 0 0 240px; border-right: 1px solid var(--line); }\n`, 1),
        ], 0),
        d('tree', [
          f('Tree.tsx', `export function Tree() { return null; }\n`, 2),
          f('TreeNode.tsx', `export function TreeNode({ entry, depth }) { return null; }\n`, 2),
          f('useExpanded.ts', `export function useExpanded() { /* persisted in localStorage */ }\n`, 4),
          f('Tree.css', `.tree-node { height: 26px; padding: 0 6px; }\n`, 4),
        ], 2),
        d('spatial', [
          f('Spatial.tsx', `export function Spatial() { return null; }\n`, 3),
          f('Tile.tsx', `export function Tile({ entry, selected }) { return null; }\n`, 3),
          f('useNavigationStack.ts', `// Forward/back history within the spatial view.\nexport function useNavigationStack() { /* ... */ }\n`, 5),
        ], 3),
        d('command', [
          f('Command.tsx', `export function Command() { return null; }\n`, 0, 5),
          f('Result.tsx', `export function Result({ hit, active }) { return null; }\n`, 0, 5),
          f('useSearch.ts', `// Debounced search hook. Cancels in-flight requests.\nexport function useSearch(query: string) { /* ... */ }\n`, 1),
        ], 0),
        d('table', [
          f('Table.tsx', `export function Table() { return null; }\n`, 4),
          f('Row.tsx', `export function Row({ entry }) { return null; }\n`, 4),
          f('useSort.ts', `export function useSort<T>(rows: T[], by: keyof T) { /* ... */ }\n`, 6),
          f('useFilter.ts', `export function useFilter<T>(rows: T[], q: string) { /* ... */ }\n`, 6),
        ], 4),
      ], 0),

      d('components', [
        d('preview', [
          f('Preview.tsx', `// Generic file preview shell.\nexport function Preview({ path }) { return null; }\n`, 5),
          f('MarkdownPreview.tsx', `// Renders markdown via marked + DOMPurify.\nexport function MarkdownPreview({ src }) { return null; }\n`, 5),
          f('CodePreview.tsx', `// Syntax-highlighted code preview via Shiki.\nexport function CodePreview({ src, lang }) { return null; }\n`, 5),
          f('ImagePreview.tsx', `export function ImagePreview({ src }) { return null; }\n`, 5),
          f('BinaryPreview.tsx', `// Hex dump for unknown binary types.\nexport function BinaryPreview({ src }) { return null; }\n`, 8),
        ], 5),
        d('breadcrumbs', [
          f('Breadcrumbs.tsx', `export function Breadcrumbs({ path, onPick }) { return null; }\n`, 7),
          f('Breadcrumbs.css', `.crumbs { display: flex; gap: 2px; }\n`, 7),
        ], 7),
        d('icons', [
          f('FolderIcon.tsx', `export function FolderIcon({ open }) { return null; }\n`, 12),
          f('FileIcon.tsx', `export function FileIcon({ entry }) { return null; }\n`, 12),
          f('LangColors.ts', `export const LANG_COLORS = { typescript: '#3178c6', /* ... */ };\n`, 12),
        ], 12),
      ], 5),

      d('styles', [
        f('global.css', STYLES_CSS, 7),
        f('tokens.css', TOKENS_CSS, 10),
        f('reset.css', `*, *::before, *::after { box-sizing: border-box; }\nbody, h1, h2, h3, p { margin: 0; }\n`, 30),
        d('themes', [
          f('light.css', `:root { --bg: #fafaf7; --ink: #1a1a17; }\n`, 14),
          f('dark.css', `[data-theme="dark"] { --bg: #15140f; --ink: #f3efe3; }\n`, 14),
        ], 14),
      ], 7),

      d('server', [
        f('routes.ts', ROUTES_TS, 2),
        f('index.ts', `import express from 'express';\nimport { fs } from './routes';\nconst app = express();\napp.use('/api/fs', fs);\napp.listen(4000, () => console.log('atlas server :4000'));\n`, 2),
        d('middleware', [
          f('auth.ts', `// Bearer-token gate. Read-only API, but still gated.\nexport function auth(req, res, next) { /* ... */ next(); }\n`, 18),
          f('rateLimit.ts', `// Token bucket: 30 req/sec per IP.\nexport function rateLimit(req, res, next) { next(); }\n`, 18),
          f('logger.ts', `// JSON access log to stdout.\nexport function logger(req, res, next) { next(); }\n`, 25),
        ], 18),
      ], 2),
    ], 0),

    // ============ docs ============
    d('docs', [
      f('fs-api.md', FS_API_MD, 1),
      f('architecture.md', `# Architecture\n\nA single \`FileSystem\` interface; multiple adapters; many views.\n\nViews never know which adapter they're talking to. Adapters never know\nwhich view is consuming them.\n`, 6),
      f('paradigms.md', `# Paradigms\n\n## Why five?\n\nFile navigation has been re-invented constantly since the 1970s.\nNone of the canonical paradigms is strictly better — they're each\noptimized for a different cognitive model.\n\n- **Columns** — best when you can predict the path you want.\n- **Tree** — best for long sessions in a known repo.\n- **Spatial** — best for "where did I put that thing".\n- **Command** — best when speed matters more than browsing.\n- **Table** — best when sorting/filtering by metadata is the goal.\n`, 0, 8),
      d('adr', [
        f('001-read-only-by-default.md', `# ADR-001: Read-only by default\n\n## Status\nAccepted, 2026-01-12.\n\n## Context\nMutation makes everything harder: cache invalidation, optimistic UI, conflict resolution, audit trails.\n\n## Decision\nThe core API is read-only. Mutation is a separate, opt-in extension.\n\n## Consequences\nAdapters are vastly simpler. Views never need to handle stale data from local writes.\n`, 90),
        f('002-posix-paths.md', `# ADR-002: POSIX-style paths everywhere\n\n## Status\nAccepted.\n\n## Decision\nAll paths use \`/\` separators. Backends translate to native paths at the boundary.\n`, 88),
        f('003-no-symlink-loops.md', `# ADR-003: Symlink loops are the adapter's problem\n\nThe core API trusts paths returned from \`resolve()\`. Loop detection lives in adapters that need it.\n`, 60),
        f('004-paginated-list.md', `# ADR-004: \`list()\` may be paginated\n\nLarge directories must not block. Adapters MAY return a continuation token; views MUST handle it gracefully.\n`, 30),
      ], 60),
      d('guides', [
        f('writing-an-adapter.md', `# Writing an adapter\n\n1. Implement the six required methods.\n2. Throw \`FsError\` with the right code.\n3. Run the conformance test suite (\`pnpm test:adapter ./my-adapter.ts\`).\n4. Submit a PR.\n`, 22),
        f('embedding-atlas.md', `# Embedding Atlas\n\nAtlas exports each view as a standalone React component. You can wire your own \`FileSystem\` and pick one (or many) views.\n`, 25),
        f('keyboard-reference.md', `# Keyboard reference\n\n| Key       | Action            |\n|-----------|-------------------|\n| ⌘1–⌘5     | Switch paradigm   |\n| ⌘K        | Open command      |\n| ↑ / ↓     | Navigate          |\n| ↵         | Open / drill in   |\n| ⌫         | Up one level      |\n| /         | Focus search      |\n| Tab       | Toggle search mode|\n`, 4),
      ], 22),
      d('api', [
        f('FileSystem.md', `# \`interface FileSystem\`\n\nThe core contract every adapter implements.\n`, 1),
        f('Stat.md', `# \`type Stat\`\n\nMetadata returned by \`stat()\` and \`list()\`.\n`, 1),
        f('FileChunk.md', `# \`type FileChunk\`\n\nReturn type of \`read()\`. May be truncated.\n`, 1),
        f('FsError.md', `# \`class FsError\`\n\nAll errors thrown by the FS API.\n`, 1),
      ], 1),
    ], 1),

    // ============ scripts ============
    d('scripts', [
      f('build-index.py', SEARCH_PY, 11),
      f('release.sh', `#!/usr/bin/env bash\nset -euo pipefail\npnpm test\npnpm build\nnpm version "$1"\nnpm publish\n`, 30),
      f('seed-fixtures.ts', `// Generate the in-memory mock dataset for tests.\nimport { writeFileSync } from 'node:fs';\nimport { faker } from '@faker-js/faker';\n/* ... */\n`, 14),
      d('migrations', [
        f('2026-03-01_drop-legacy-list.ts', `// Removes the deprecated fs.legacyList() endpoint.\nexport async function up() { /* ... */ }\n`, 67),
        f('2026-04-15_add-fts5-index.ts', `// Builds the FTS5 search index on first run.\nexport async function up() { /* ... */ }\n`, 22),
      ], 22),
    ], 11),

    // ============ tests ============
    d('tests', [
      d('unit', [
        f('paths.spec.ts', `import { describe, it, expect } from 'vitest';\nimport { Path } from '../../src/fs/path';\n\ndescribe('Path', () => {\n  it('normalizes', () => {\n    expect(Path.normalize('/a/./b/../c')).toBe('/a/c');\n  });\n  it('joins', () => {\n    expect(Path.join('/a', 'b', 'c')).toBe('/a/b/c');\n  });\n});\n`, 5),
        f('mime.spec.ts', `// Coverage for extension -> mime mapping.\n`, 9),
        f('fuzzy.spec.ts', `// Scorer behavior on edge cases.\n`, 13),
      ], 5),
      d('integration', [
        f('in-memory.spec.ts', `import { describe, it, expect } from 'vitest';\nimport { InMemoryFs } from '../../src/fs/adapters/in-memory';\n\ndescribe('InMemoryFs', () => {\n  it('lists root', async () => {\n    const fs = new InMemoryFs([{ type: 'file', name: 'a.txt', content: 'hi' }]);\n    const out = await fs.list('/');\n    expect(out).toHaveLength(1);\n  });\n});\n`, 5),
        f('http.spec.ts', `// Spins up an express server and runs the conformance suite against it.\n`, 12),
        f('zip.spec.ts', `// Loads a fixture .zip, runs the conformance suite.\n`, 22),
      ], 12),
      d('conformance', [
        f('suite.ts', `// The shared conformance suite. Any FileSystem implementation\n// can be passed in and exercised against the full contract.\nimport { describe, it, expect } from 'vitest';\nexport function runSuite(fs: any, name: string) {\n  describe(name + ' conformance', () => {\n    it('throws ENOENT on missing path', async () => { /* ... */ });\n    it('throws ENOTDIR when listing a file', async () => { /* ... */ });\n    it('returns dirs before files when sorting', async () => { /* ... */ });\n  });\n}\n`, 10),
        f('README.md', `# Conformance suite\n\nEvery adapter MUST pass this suite. Run with:\n\n\`\`\`bash\npnpm test:conformance ./path/to/my-adapter.ts\n\`\`\`\n`, 10),
      ], 10),
      d('fixtures', [
        d('small-repo', [
          f('a.txt', 'hello\n', 100),
          f('b.txt', 'world\n', 100),
          d('nested', [
            f('c.txt', 'deep\n', 100),
            f('d.txt', 'deeper\n', 100),
          ], 100),
        ], 100),
        d('large-tree', [
          f('manifest.json', `{ "files": 5000, "depth": 8 }\n`, 100),
        ], 100),
      ], 100),
    ], 5),

    // ============ public ============
    d('public', [
      f('favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#b8482e"/></svg>`, 50),
      f('index.html', `<!doctype html>\n<html>\n  <head><title>Atlas</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n`, 50),
      f('robots.txt', `User-agent: *\nDisallow:\n`, 200),
      d('fonts', [
        f('SourceSerif4-Variable.woff2', '[binary]', 180),
        f('Inter-Variable.woff2', '[binary]', 180),
        f('JetBrainsMono-Variable.woff2', '[binary]', 180),
      ], 180),
      d('img', [
        f('og-image.png', '[binary png 1200x630]', 90),
        f('logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#b8482e"/><text x="50" y="58" font-family="serif" font-size="40" fill="white" text-anchor="middle">A</text></svg>`, 90),
      ], 90),
    ], 50),

    // ============ .github (hidden) ============
    d('.github', [
      d('workflows', [
        f('ci.yml', `name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: pnpm/action-setup@v3\n      - run: pnpm install\n      - run: pnpm test\n`, 14),
        f('release.yml', `name: release\non: { push: { tags: [ 'v*' ] } }\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm publish --no-git-checks\n`, 30),
      ], 14),
      f('CODEOWNERS', `* @atlas/maintainers\n/docs/ @atlas/docs\n/src/fs/ @atlas/core\n`, 60),
      f('PULL_REQUEST_TEMPLATE.md', `## Summary\n\n## Changes\n\n## Testing\n`, 60),
    ], 14, { hidden: true }),
  ];

  window.MOCK_REPO = data;
})();

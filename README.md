# Atlas — File System Navigator

Two read-only filesystem navigators (Miller Columns + Tree+Detail) that plug into any backend conforming to a small `FileSystem` interface. Ships with an in-memory mock dataset and an [OpenViking](https://github.com/volcengine/OpenViking) adapter.

## Live demo

→ **[https://zaynjarvis.github.io/atlas-fs/](https://zaynjarvis.github.io/atlas-fs/)**


## Run locally

It's a static site. Open `Atlas.html` directly, or:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/Atlas.html
```

## Backend

Open the gear icon → **Backend** to switch between:

- **OpenViking** — point at any OpenViking server (URL + API key)
- **Mock** — bundled in-memory repo, no network

## Plug in your own filesystem

Implement `FileSystem` from `fs-api.js`:

```js
class MyFs {
  async list(path, opts)   { /* return Entry[] */ }
  async stat(path)         { /* return Entry */ }
  async read(path, opts)   { /* return { content, encoding, ... } */ }
  async ping()             { /* throw on auth/connectivity failure */ }
}
```

Register and select it in `Atlas.html`'s backend tweaks.

## Files

| File | Purpose |
|---|---|
| `Atlas.html` | App shell, theming, backend switching |
| `fs-api.js` | `FileSystem` interface + `InMemoryFs` |
| `openviking-adapter.js` | OpenViking HTTP adapter |
| `mock-data.js` | Mock repo dataset |
| `views.jsx` | Columns + Tree views |
| `ui-helpers.jsx` | Shared UI primitives |
| `renderers.jsx` | Markdown / JSON / JSONL preview renderers |
| `tweaks-panel.jsx` | In-page tweak panel |
| `styles.css`, `views.css`, `renderers.css` | Theming + layout |

## Deploy to GitHub Pages

This repo includes `.github/workflows/pages.yml`. After pushing to `main`:

1. Repo → **Settings → Pages**
2. **Source**: GitHub Actions
3. Wait for the **Deploy to Pages** action to finish — your site is at `https://USERNAME.github.io/REPO/`

The workflow publishes the repo root as-is (it's already a static site) and rewrites `index.html` → `Atlas.html` so the bare URL works.

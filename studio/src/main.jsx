import './styles.css';
import './legacy/renderers.css';
// Atlas data layer (unchanged): Path utils + OpenViking adapter publish window.FS.
import './legacy/fs-api.js';
import './legacy/openviking-adapter.js';
import { renderMarkdown, renderJson, renderJsonl, renderPlainCode } from './legacy/renderers.jsx';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

window.AtlasRenderers = { renderMarkdown, renderJson, renderJsonl, renderPlainCode };
createRoot(document.getElementById('app')).render(<App />);

/**
 * Rich content renderers — Markdown, JSON, JSONL.
 *
 * Tailored for the Atlas preview pane. The Markdown renderer covers the
 * common-mark flavor we actually see in code and design notes (headings,
 * lists, code, tables, blockquotes, hr, inline code/bold/italic/links). The
 * JSON renderer is colorized with collapse toggles. JSONL renders each line
 * as a numbered, individually-collapsible record. None of these are general-
 * purpose — they're tuned to look great in the Atlas L0/L1/L2 preview.
 */
const { useState, useMemo, useCallback, Fragment } = React;

// ---------- Inline parser shared by md ----------
function mdInline(s, keyPrefix = '') {
  const out = [];
  let i = 0;
  let buf = '';
  let kid = 0;
  const flush = () => {
    if (buf) { out.push(buf); buf = ''; }
  };
  const push = (node) => {
    flush();
    out.push(<Fragment key={keyPrefix + 'k' + (kid++)}>{node}</Fragment>);
  };

  while (i < s.length) {
    const ch = s[i];

    // inline code `…`
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) {
        push(<code className="md-icode">{s.slice(i + 1, j)}</code>);
        i = j + 1; continue;
      }
    }

    // bold **…**
    if (ch === '*' && s[i + 1] === '*') {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) {
        push(<strong>{mdInline(s.slice(i + 2, j), keyPrefix + 'b' + i + '_')}</strong>);
        i = j + 2; continue;
      }
    }

    // italic *…* or _…_
    if (ch === '*' || ch === '_') {
      const close = s.indexOf(ch, i + 1);
      // Avoid pairing across whitespace-only or word chars on outside
      if (close > i + 1 && s[i + 1] !== ' ' && s[close - 1] !== ' ') {
        push(<em>{mdInline(s.slice(i + 1, close), keyPrefix + 'i' + i + '_')}</em>);
        i = close + 1; continue;
      }
    }

    // link [text](url)
    if (ch === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && s[close + 1] === '(') {
        const end = s.indexOf(')', close + 2);
        if (end > 0) {
          const text = s.slice(i + 1, close);
          const url = s.slice(close + 2, end);
          push(<a href={url} target="_blank" rel="noopener noreferrer">{text}</a>);
          i = end + 1; continue;
        }
      }
    }

    // raw URL  http(s)://…
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(s.slice(i))) {
      const m = s.slice(i).match(/^https?:\/\/[^\s)]+/i);
      if (m) {
        push(<a href={m[0]} target="_blank" rel="noopener noreferrer">{m[0]}</a>);
        i += m[0].length; continue;
      }
    }

    buf += ch; i++;
  }
  flush();
  return out;
}

// ---------- Markdown block parser ----------
function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let key = 0;
  const k = () => 'md' + (key++);

  while (i < lines.length) {
    const ln = lines[i];

    // fenced code block ```lang … ```
    if (/^```/.test(ln)) {
      const lang = ln.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      i++; // skip closing ```
      out.push(
        <pre key={k()} className="md-pre">
          {lang && <span className="md-pre-lang">{lang}</span>}
          <code>{buf.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(ln)) {
      out.push(<hr key={k()} className="md-hr" />);
      i++; continue;
    }

    // heading
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const Tag = 'h' + level;
      out.push(<Tag key={k()} className={'md-h md-h' + level}>{mdInline(h[2], k() + '_')}</Tag>);
      i++; continue;
    }

    // blockquote (collect contiguous > lines)
    if (/^>\s?/.test(ln)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(
        <blockquote key={k()} className="md-blockquote">
          {renderMarkdown(buf.join('\n'))}
        </blockquote>
      );
      continue;
    }

    // table — header row + separator. Loosen body row matching to "any line with a pipe".
    if (/\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (row) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = splitRow(ln);
      const sep = splitRow(lines[i + 1]);
      const aligns = sep.map((s) => {
        const left = s.startsWith(':');
        const right = s.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i])); i++;
      }
      out.push(
        <div key={k()} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{header.map((c, j) => <th key={j} style={{textAlign: aligns[j] || 'left'}}>{mdInline(c, k() + '_')}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => <td key={ci} style={{textAlign: aligns[ci] || 'left'}}>{mdInline(c, k() + '_')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // (legacy block removed — handled above)

    // unordered list
    if (/^\s*[-*+]\s+/.test(ln)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*[-*+]\s+/, '');
        const sub = [];
        i++;
        // continuation lines (indented)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) {
          sub.push(lines[i].replace(/^\s+/, ''));
          i++;
        }
        items.push(content + (sub.length ? '\n' + sub.join('\n') : ''));
      }
      out.push(
        <ul key={k()} className="md-list">
          {items.map((it, idx) => <li key={idx}>{mdInline(it, k() + '_')}</li>)}
        </ul>
      );
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(ln)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(
        <ol key={k()} className="md-list">
          {items.map((it, idx) => <li key={idx}>{mdInline(it, k() + '_')}</li>)}
        </ol>
      );
      continue;
    }

    // blank line
    if (/^\s*$/.test(ln)) { i++; continue; }

    // paragraph (collect contiguous non-empty, non-block lines)
    const para = [ln];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|\s*\|)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    out.push(<p key={k()} className="md-p">{mdInline(para.join(' '), k() + '_')}</p>);
  }
  return out;
}

// ---------- JSON renderer (collapsible, colorized) ----------
function JsonValue({ value, depth = 0, defaultOpen = true, lastSibling = true }) {
  const [open, setOpen] = useState(depth < 2 ? defaultOpen : false);

  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === 'boolean') return <span className="json-bool">{String(value)}</span>;
  if (typeof value === 'number') return <span className="json-num">{value}</span>;
  if (typeof value === 'string') {
    return <span className="json-str">"{value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"</span>;
  }

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const open$ = isArr ? '[' : '{';
  const close$ = isArr ? ']' : '}';

  if (entries.length === 0) {
    return <span className="json-bracket">{open$}{close$}</span>;
  }

  if (!open) {
    return (
      <span className="json-collapsed" onClick={() => setOpen(true)}>
        <span className="json-bracket">{open$}</span>
        <span className="json-summary">{entries.length} {isArr ? 'items' : 'keys'}</span>
        <span className="json-bracket">{close$}</span>
      </span>
    );
  }

  return (
    <span className="json-block">
      <span className="json-bracket json-bracket-open" onClick={() => setOpen(false)}>
        <span className="json-twirl">▾</span>
        {open$}
      </span>
      <div className="json-children">
        {entries.map(([k, v], idx) => (
          <div className="json-row" key={idx}>
            {!isArr && <span className="json-key">"{k}"</span>}
            {!isArr && <span className="json-colon">: </span>}
            <JsonValue value={v} depth={depth + 1} lastSibling={idx === entries.length - 1} />
            {idx < entries.length - 1 && <span className="json-comma">,</span>}
          </div>
        ))}
      </div>
      <span className="json-bracket">{close$}</span>
    </span>
  );
}

function renderJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Fallback to plain pre with the parse error noted
    return (
      <div className="json-error">
        <div className="json-error-head">JSON parse error: {e.message}</div>
        <pre className="json-raw">{text}</pre>
      </div>
    );
  }
  return (
    <div className="json-root">
      <JsonValue value={parsed} depth={0} />
    </div>
  );
}

// ---------- JSONL renderer ----------
function JsonlRow({ line, index }) {
  const [open, setOpen] = useState(false);
  let parsed = null;
  let err = null;
  try { parsed = JSON.parse(line); } catch (e) { err = e; }

  // Pull a sensible 1-line summary
  const summary = useMemo(() => {
    if (err) return line.length > 200 ? line.slice(0, 200) + '…' : line;
    if (parsed === null) return 'null';
    if (typeof parsed !== 'object') return JSON.stringify(parsed);
    if (Array.isArray(parsed)) return `[${parsed.length}]`;
    const keys = Object.keys(parsed);
    // Prefer common "title" keys for a readable summary
    const titleKey = ['name', 'title', 'event', 'type', 'role', 'method'].find((k) => k in parsed);
    if (titleKey) {
      const v = parsed[titleKey];
      const rest = keys.filter((k) => k !== titleKey).slice(0, 3);
      const tail = rest.length ? `  ·  ${rest.join(', ')}` : '';
      return (
        <>
          <span className="jsonl-tag">{titleKey}</span>
          <span className="jsonl-tag-val">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
          <span className="jsonl-keys">{tail}</span>
        </>
      );
    }
    return <span className="jsonl-keys">{keys.slice(0, 6).join(', ')}{keys.length > 6 ? '…' : ''}</span>;
  }, [line]);

  return (
    <div className={'jsonl-row' + (err ? ' jsonl-err' : '')} data-open={open}>
      <button className="jsonl-gutter" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'}>
        <span className="jsonl-num">{index + 1}</span>
        <span className="jsonl-twirl">{open ? '▾' : '▸'}</span>
      </button>
      <div className="jsonl-content">
        {!open && <div className="jsonl-summary">{summary}</div>}
        {open && (
          err ? <pre className="jsonl-raw">{line}</pre>
              : <div className="jsonl-detail"><JsonValue value={parsed} depth={0} /></div>
        )}
      </div>
    </div>
  );
}

function renderJsonl(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return <div className="jsonl-empty">Empty JSONL.</div>;
  }
  return (
    <div className="jsonl-root">
      <div className="jsonl-meta">
        <span className="jsonl-count">{lines.length} record{lines.length === 1 ? '' : 's'}</span>
      </div>
      {lines.map((ln, i) => <JsonlRow key={i} line={ln} index={i} />)}
    </div>
  );
}

// ---------- Plain code (fallback line-numbered, lightly colorized) ----------
function renderPlainCode(text, lang) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return (
    <div className="code-block" data-lang={lang || ''}>
      {lines.map((ln, i) => (
        <div className="code-line" key={i}>
          <span className="code-num">{i + 1}</span>
          <span className="code-text">{ln || '\u00A0'}</span>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, {
  renderMarkdown, renderJson, renderJsonl, renderPlainCode,
  JsonValue,
});

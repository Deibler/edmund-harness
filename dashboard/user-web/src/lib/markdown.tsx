import type { ReactNode } from "react";

/**
 * The person file is markdown-ish: headings, bullets, bold, italics, code.
 * Rendered to React nodes (never HTML strings), so nothing in the file can
 * become markup. Heading levels shift down one so they sit under the page
 * title.
 */
export function renderMarkdown(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  let key = 0;
  const flush = () => {
    if (list.length) {
      out.push(<ul key={key++}>{list}</ul>);
      list = [];
    }
  };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h?.[1] && h[2] !== undefined) {
      flush();
      const lvl = Math.min(h[1].length + 1, 5);
      const body = inline(h[2]);
      out.push(
        lvl === 2 ? (
          <h2 key={key++}>{body}</h2>
        ) : lvl === 3 ? (
          <h3 key={key++}>{body}</h3>
        ) : (
          <h4 key={key++}>{body}</h4>
        ),
      );
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li?.[1] !== undefined) {
      list.push(<li key={key++}>{inline(li[1])}</li>);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^[-_*]{3,}$/.test(line.trim())) {
      flush();
      out.push(<hr key={key++} />);
      continue;
    }
    flush();
    out.push(<p key={key++}>{inline(line)}</p>);
  }
  flush();
  return out;
}

/** **bold**, `code`, *italic*, _italic_. */
function inline(s: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|(?<![*\w])\*[^*\s][^*]*\*|(?<![\w])_[^_\s][^_]*_(?![\w]))/g;
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(s.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith("**")) nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else nodes.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes;
}

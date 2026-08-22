import { Fragment, createElement, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import type { Citation } from '@/api/client';

/**
 * Renders an AI chat answer that may contain:
 *  - Markdown structure (headings, bold/italic, lists, tables, code, links)
 *  - Inline citation markers like `[1]`, `[2]` that correspond 1:1 with the
 *    `citations` array position (see backend `rag_pipeline.py`).
 *
 * Citation markers are rendered as small numbered chips. Hovering (or
 * focusing, for keyboard/touch) shows a lightweight floating preview of the
 * source - similar to how Wikipedia previews a footnote on hover - instead
 * of the previous approach of dumping a full citation card into the flow of
 * the conversation for every single reference.
 */
export function MarkdownMessage({
  content,
  citations,
  onOpenCitation,
}: {
  content: string;
  citations?: Citation[];
  onOpenCitation?: (citation: Citation) => void;
}) {
  const blocks = parseBlocks(content);
  return (
    <div className="markdown-body">
      {blocks.map((block, index) => (
        <Fragment key={index}>{renderBlock(block, index, citations, onOpenCitation)}</Fragment>
      ))}
    </div>
  );
}

/* ------------------------------- Block parsing ------------------------------- */

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'table'; header: string[]; align: Array<'left' | 'center' | 'right' | null>; rows: string[][] };

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // Fenced code block
    if (/^```/.test(line.trim())) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { codeLines.push(lines[i]); i += 1; }
      i += 1; // skip closing fence
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    // Table: a header row immediately followed by a separator row
    if (line.includes('|') && lines[i + 1] && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center' as const;
        if (right) return 'right' as const;
        if (left) return 'left' as const;
        return null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitTableRow(lines[i])); i += 1; }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { blocks.push({ type: 'hr' }); i += 1; continue; }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quoteLines.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push({ type: 'quote', text: quoteLines.join(' ') });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i += 1; }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i += 1; }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Paragraph: gather consecutive plain lines
    const paragraphLines: string[] = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !(lines[i].includes('|') && lines[i + 1] && TABLE_SEPARATOR.test(lines[i + 1]))
    ) { paragraphLines.push(lines[i]); i += 1; }
    blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') });
  }

  return blocks;
}

/* ------------------------------ Block rendering ------------------------------ */

function renderBlock(
  block: Block,
  key: number,
  citations?: Citation[],
  onOpenCitation?: (citation: Citation) => void,
): ReactNode {
  const inline = (text: string) => renderInline(text, citations, onOpenCitation);
  switch (block.type) {
    case 'heading': {
      const tagName = `h${Math.min(block.level + 2, 6)}`;
      return createElement(tagName, { className: 'md-heading' }, inline(block.text));
    }
    case 'paragraph':
      return <p className="md-paragraph">{block.text.split('\n').map((line, lineIndex) => (
        <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{inline(line)}</Fragment>
      ))}</p>;
    case 'code':
      return <pre className="md-code-block"><code>{block.text}</code></pre>;
    case 'quote':
      return <blockquote className="md-quote">{inline(block.text)}</blockquote>;
    case 'hr':
      return <hr className="md-hr" />;
    case 'ul':
      return <ul className="md-list">{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ul>;
    case 'ol':
      return <ol className="md-list">{block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ol>;
    case 'table':
      return (
        <div className="md-table-wrap" key={key}>
          <table className="md-table">
            <thead>
              <tr>{block.header.map((cell, cellIndex) => (
                <th key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>{inline(cell)}</th>
              ))}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>{inline(cell)}</td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

/* ------------------------------ Inline rendering ------------------------------ */

// Order of alternatives matters: code span first (so ** inside `code` isn't
// treated as bold), then bold, then links, then bare citation markers
// (a `[n]` NOT immediately followed by `(` so it doesn't collide with link
// syntax), then italics.
const INLINE_PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\(([^)]+)\)|\[(\d+)\](?!\()|\*([^*]+)\*|_([^_]+)_/g;

function renderInline(text: string, citations?: Citation[], onOpenCitation?: (citation: Citation) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [, code, boldStar, boldUnderscore, linkText, linkUrl, citationNumber, italicStar, italicUnderscore] = match;
    if (code !== undefined) {
      nodes.push(<code className="md-inline-code" key={key++}>{code}</code>);
    } else if (boldStar !== undefined || boldUnderscore !== undefined) {
      nodes.push(<strong key={key++}>{renderInline(boldStar ?? boldUnderscore, citations, onOpenCitation)}</strong>);
    } else if (linkText !== undefined) {
      nodes.push(<a className="md-link" key={key++} href={linkUrl} target="_blank" rel="noreferrer">{linkText}</a>);
    } else if (citationNumber !== undefined) {
      const citation = citations?.[Number(citationNumber) - 1];
      nodes.push(
        <CitationMarker key={key++} index={Number(citationNumber)} citation={citation} onOpen={onOpenCitation} />,
      );
    } else if (italicStar !== undefined || italicUnderscore !== undefined) {
      nodes.push(<em key={key++}>{renderInline(italicStar ?? italicUnderscore, citations, onOpenCitation)}</em>);
    }
    lastIndex = INLINE_PATTERN.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/* ------------------------------ Citation marker ------------------------------ */

/**
 * Wikipedia-style footnote: a small numbered marker that, on hover or
 * keyboard focus, shows a floating popover previewing the source (filename,
 * page, line range, and a short excerpt) without leaving the chat. Clicking
 * it opens the full source in the PDF viewer, same as before.
 */
export function CitationMarker({
  index,
  citation,
  onOpen,
}: {
  index: number;
  citation?: Citation;
  onOpen?: (citation: Citation) => void;
}) {
  if (!citation) return <sup className="citation-marker citation-marker-unresolved">[{index}]</sup>;
  return (
    <span className="citation-marker-wrap">
      <button
        type="button"
        className="citation-marker"
        onClick={() => onOpen?.(citation)}
        aria-label={`Show source ${index}: ${citation.filename}, page ${citation.page}`}
      >
        {index}
      </button>
      <span className="citation-popover" role="tooltip">
        <span className="citation-popover-title">{citation.filename}</span>
        <span className="citation-popover-meta">Page {citation.page} · lines {citation.line_start ?? '—'}–{citation.line_end ?? '—'}</span>
        <span className="citation-popover-snippet">{/* Safe by default: React escapes citation snippets as text. */}{citation.snippet}</span>
        {onOpen && <span className="citation-popover-hint">Open source <ArrowRight size={11} /></span>}
      </span>
    </span>
  );
}

// W3C-Web-Annotation-style TextQuoteSelector anchoring.
//
// A comment stores the selected text plus a bit of context before and after.
// To re-locate the comment after the document changes, we search for the
// prefix+exact+suffix combo, falling back to lighter matches. If nothing
// resolves, the comment becomes "obsolete" — kept around with the dead quote
// visible so the user can still read what was being said.

export interface TextAnchor {
  prefix: string;
  exact: string;
  suffix: string;
}

const CTX = 48; // chars of context to capture on each side

export function buildAnchorFromText(content: string, start: number, end: number): TextAnchor {
  return {
    prefix: content.slice(Math.max(0, start - CTX), start),
    exact: content.slice(start, end),
    suffix: content.slice(end, Math.min(content.length, end + CTX)),
  };
}

// Returns the [start, end) character offsets where the anchor resolves in
// `content`, or null if it can't be located.
export function locateAnchor(content: string, anchor: TextAnchor): { start: number; end: number } | null {
  if (!anchor.exact) return null;

  // 1) Strongest: full prefix + exact + suffix
  if (anchor.prefix || anchor.suffix) {
    const full = anchor.prefix + anchor.exact + anchor.suffix;
    const i = content.indexOf(full);
    if (i >= 0) {
      const s = i + anchor.prefix.length;
      return { start: s, end: s + anchor.exact.length };
    }
  }

  // 2) Prefix + exact only
  if (anchor.prefix) {
    const pe = anchor.prefix + anchor.exact;
    const i = content.indexOf(pe);
    if (i >= 0) {
      const s = i + anchor.prefix.length;
      return { start: s, end: s + anchor.exact.length };
    }
  }

  // 3) Exact + suffix only
  if (anchor.suffix) {
    const es = anchor.exact + anchor.suffix;
    const i = content.indexOf(es);
    if (i >= 0) return { start: i, end: i + anchor.exact.length };
  }

  // 4) Last resort: exact alone, only if unambiguous
  if (anchor.exact.length >= 4) {
    const first = content.indexOf(anchor.exact);
    if (first < 0) return null;
    const second = content.indexOf(anchor.exact, first + 1);
    if (second < 0) return { start: first, end: first + anchor.exact.length };
    // Multiple matches; we don't know which one — treat as unresolved.
  }
  return null;
}

// Capture the current window selection within `root` and turn it into a
// TextAnchor against the *visible* text. Returns null when nothing is selected
// or the selection escapes the root.
export function captureSelectionAnchor(root: HTMLElement): { anchor: TextAnchor; rect: DOMRect } | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const exact = sel.toString();
  if (!exact.trim()) return null;

  const fullText = root.textContent ?? "";
  // Map the range's start to a char offset in fullText by walking text nodes.
  const startOffset = offsetInRoot(root, range.startContainer, range.startOffset);
  if (startOffset < 0) return null;
  const endOffset = startOffset + exact.length;

  const rect = range.getBoundingClientRect();
  return { anchor: buildAnchorFromText(fullText, startOffset, endOffset), rect };
}

function offsetInRoot(root: Node, container: Node, offsetInContainer: number): number {
  // If the container is a text node, count text chars before it then add the offset.
  // If the container is an element, the offset is a child index — descend into the
  // appropriate child first.
  if (container.nodeType !== Node.TEXT_NODE) {
    const target = container.childNodes[offsetInContainer] ?? null;
    if (!target) {
      // After the last child — count everything in container.
      let total = 0;
      const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = w.nextNode())) total += (n as Text).data.length;
      return offsetInRoot(root, container, 0) + total;
    }
    return offsetInRoot(root, target, 0);
  }
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === container) return offset + offsetInContainer;
    offset += (node as Text).data.length;
  }
  return -1;
}

// Wrap a (start, end) range of visible text in `root` with <mark> tags carrying
// data-comment-id. Handles ranges that span multiple text nodes by emitting a
// separate <mark> per piece.
export function wrapRangeInMarks(root: HTMLElement, start: number, end: number, commentId: number, opts?: { obsolete?: boolean }): boolean {
  if (start >= end) return false;
  // Collect all text nodes with their cumulative offsets.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let pos = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const len = t.data.length;
    nodes.push({ node: t, start: pos, end: pos + len });
    pos += len;
  }

  // Wrap each affected piece. We splice from the end backward to avoid
  // invalidating downstream offsets.
  const affected = nodes.filter((p) => p.end > start && p.start < end).reverse();
  let any = false;
  for (const p of affected) {
    const localStart = Math.max(0, start - p.start);
    const localEnd = Math.min(p.node.data.length, end - p.start);
    if (localEnd <= localStart) continue;
    wrapPart(p.node, localStart, localEnd, commentId, opts?.obsolete);
    any = true;
  }
  return any;
}

function wrapPart(textNode: Text, start: number, end: number, commentId: number, obsolete?: boolean) {
  const parent = textNode.parentNode;
  if (!parent) return;
  const data = textNode.data;
  const before = start > 0 ? document.createTextNode(data.slice(0, start)) : null;
  const middleText = data.slice(start, end);
  const after = end < data.length ? document.createTextNode(data.slice(end)) : null;
  const mark = document.createElement("mark");
  mark.dataset.commentId = String(commentId);
  if (obsolete) mark.dataset.obsolete = "1";
  mark.textContent = middleText;
  if (before) parent.insertBefore(before, textNode);
  parent.insertBefore(mark, textNode);
  if (after) parent.insertBefore(after, textNode);
  parent.removeChild(textNode);
}

export function clearHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll("mark[data-comment-id]");
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  // Merge adjacent text nodes so the next pass walks clean.
  normalize(root);
}

function normalize(root: Node) {
  root.normalize();
}

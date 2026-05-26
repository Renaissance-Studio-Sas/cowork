// Returns an HTML document string that wraps `userHtml` with a small
// enhancer script. The script bridges the iframe<->parent boundary so
// selections, right-click, and start-typing fire postMessage events the
// FileViewer can react to. It also receives comments from the parent and
// applies inline <mark> highlights inside the iframe.

export function buildEnhancedHtml(userHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  mark[data-wb-comment] {
    background: rgba(37, 99, 235, 0.16);
    color: inherit;
    border-bottom: 1.5px solid #2563eb;
    padding: 0 1px;
    border-radius: 2px;
    cursor: pointer;
    transition: background 120ms ease, border-bottom-color 120ms ease;
  }
  mark[data-wb-comment]:hover { background: rgba(37, 99, 235, 0.24); }
  mark[data-wb-comment].active {
    background: rgba(251, 191, 36, 0.35);
    border-bottom-color: #f59e0b;
  }
</style>
</head><body>
${userHtml}
<script>
(function() {
  const CTX = 48;
  let lastSelText = "";

  // Build a string equal to TreeWalker-concatenated text node data (same as
  // body.textContent), so offsets here also match what we use when wrapping.
  function gatherText() {
    let s = "";
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) s += n.data;
    return s;
  }

  // Walk the same TreeWalker until we reach the (container, offset) point of a
  // Range endpoint, returning the cumulative character offset.
  function offsetOf(container, off) {
    if (container.nodeType !== 3) {
      const child = container.childNodes[off] || null;
      if (!child) {
        // After last child — count everything inside container.
        let total = 0;
        const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) total += n.data.length;
        return offsetOf(container, 0) + total;
      }
      return offsetOf(child, 0);
    }
    let offset = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === container) return offset + off;
      offset += n.data.length;
    }
    return -1;
  }

  function postSelection() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      if (lastSelText) {
        lastSelText = "";
        parent.postMessage({ type: "wb:selection-cleared" }, "*");
      }
      return;
    }
    const visible = sel.toString();
    if (!visible.trim()) {
      if (lastSelText) {
        lastSelText = "";
        parent.postMessage({ type: "wb:selection-cleared" }, "*");
      }
      return;
    }
    if (visible === lastSelText) return;
    lastSelText = visible;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const text = gatherText();
    const start = offsetOf(range.startContainer, range.startOffset);
    const end = offsetOf(range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) return;

    const anchor = {
      prefix: text.slice(Math.max(0, start - CTX), start),
      exact: text.slice(start, end),
      suffix: text.slice(end, Math.min(text.length, end + CTX)),
    };

    const iframe = window.frameElement;
    const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
    parent.postMessage({
      type: "wb:selection",
      anchor: anchor,
      rect: {
        left: iframeRect.left + rect.left,
        top: iframeRect.top + rect.top,
        width: rect.width,
        height: rect.height,
      },
    }, "*");
  }

  document.addEventListener("mouseup", function () { setTimeout(postSelection, 0); });
  document.addEventListener("selectionchange", function () { setTimeout(postSelection, 0); });

  document.addEventListener("contextmenu", function (e) {
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return;
    e.preventDefault();
    const iframe = window.frameElement;
    const iframeRect = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
    parent.postMessage({
      type: "wb:contextmenu",
      x: iframeRect.left + e.clientX,
      y: iframeRect.top + e.clientY,
    }, "*");
  });

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!e.key || e.key.length !== 1) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return;
    e.preventDefault();
    parent.postMessage({ type: "wb:typed", key: e.key }, "*");
  });

  // Whitespace-collapsed copy of text with a back-map to original offsets.
  function collapseWithMap(text) {
    let out = "";
    const map = [];
    let prevSpace = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const isWs = c === " " || c === "\\t" || c === "\\n" || c === "\\r";
      if (isWs) {
        if (!prevSpace && out.length > 0) {
          out += " ";
          map.push(i);
          prevSpace = true;
        }
      } else {
        out += c;
        map.push(i);
        prevSpace = false;
      }
    }
    return { text: out, map: map };
  }

  function locate(text, a) {
    if (!a || !a.exact) return null;
    const exact = a.exact;
    const prefix = a.prefix || "";
    const suffix = a.suffix || "";

    // 1) Strict match
    if (prefix || suffix) {
      const i = text.indexOf(prefix + exact + suffix);
      if (i >= 0) return { start: i + prefix.length, end: i + prefix.length + exact.length };
    }
    if (prefix) {
      const i = text.indexOf(prefix + exact);
      if (i >= 0) return { start: i + prefix.length, end: i + prefix.length + exact.length };
    }
    if (suffix) {
      const i = text.indexOf(exact + suffix);
      if (i >= 0) return { start: i, end: i + exact.length };
    }
    if (exact.length >= 4) {
      const first = text.indexOf(exact);
      if (first >= 0) {
        const second = text.indexOf(exact, first + 1);
        if (second < 0) return { start: first, end: first + exact.length };
      }
    }

    // 2) Whitespace-tolerant fallback. Older anchors captured against
    //    innerText (which inserts newlines at block boundaries) will not
    //    match the textContent string verbatim, so we collapse runs of
    //    whitespace and search in the collapsed space, mapping back.
    function ws(s) { return s.replace(/\\s+/g, " ").replace(/^\\s+|\\s+$/g, ""); }
    const ce = ws(exact);
    if (ce.length < 4) return null;
    const cp = ws(prefix);
    const cs = ws(suffix);
    const ci = collapseWithMap(text);
    const collapsed = ci.text;
    const map = ci.map;
    const candidates = [];
    if (cp || cs) candidates.push((cp ? cp + " " : "") + ce + (cs ? " " + cs : ""));
    if (cp) candidates.push(cp + " " + ce);
    if (cs) candidates.push(ce + " " + cs);

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const at = collapsed.indexOf(cand);
      if (at < 0) continue;
      const exactInCand = cand.indexOf(ce);
      if (exactInCand < 0) continue;
      const startCol = at + exactInCand;
      const endCol = startCol + ce.length;
      const startRaw = map[startCol];
      const endRaw = endCol < map.length ? map[endCol] : map[map.length - 1] + 1;
      if (typeof startRaw === "number" && typeof endRaw === "number" && endRaw > startRaw) {
        return { start: startRaw, end: endRaw };
      }
    }
    // Unique exact in collapsed text
    const f = collapsed.indexOf(ce);
    if (f >= 0 && collapsed.indexOf(ce, f + 1) < 0) {
      const sRaw = map[f];
      const eRaw = (f + ce.length) < map.length ? map[f + ce.length] : map[map.length - 1] + 1;
      if (typeof sRaw === "number" && typeof eRaw === "number" && eRaw > sRaw) {
        return { start: sRaw, end: eRaw };
      }
    }
    return null;
  }

  function clearHighlights() {
    const marks = document.querySelectorAll("mark[data-wb-comment]");
    marks.forEach(function (m) {
      const p = m.parentNode;
      if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    });
    document.body.normalize();
  }

  function wrapRange(start, end, commentId) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let pos = 0;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.data.length;
      nodes.push({ node: n, start: pos, end: pos + len });
      pos += len;
    }
    const affected = nodes.filter(function (p) { return p.end > start && p.start < end; }).reverse();
    for (let i = 0; i < affected.length; i++) {
      const p = affected[i];
      const ls = Math.max(0, start - p.start);
      const le = Math.min(p.node.data.length, end - p.start);
      if (le <= ls) continue;
      const before = ls > 0 ? document.createTextNode(p.node.data.slice(0, ls)) : null;
      const middle = p.node.data.slice(ls, le);
      const after = le < p.node.data.length ? document.createTextNode(p.node.data.slice(le)) : null;
      const mark = document.createElement("mark");
      mark.dataset.wbComment = String(commentId);
      mark.textContent = middle;
      const parent = p.node.parentNode;
      if (!parent) continue;
      if (before) parent.insertBefore(before, p.node);
      parent.insertBefore(mark, p.node);
      if (after) parent.insertBefore(after, p.node);
      parent.removeChild(p.node);
    }
  }

  function applyComments(list) {
    clearHighlights();
    const items = list || [];
    const text = gatherText();
    const located = [];
    const obsolete = [];
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const r = locate(text, c.anchor);
      if (r) located.push({ id: c.id, r: r });
      else obsolete.push(c.id);
    }
    located.sort(function (a, b) { return b.r.start - a.r.start; });
    for (let i = 0; i < located.length; i++) wrapRange(located[i].r.start, located[i].r.end, located[i].id);
    parent.postMessage({
      type: "wb:comments-applied",
      located: located.map(function (x) { return x.id; }),
      obsolete: obsolete,
    }, "*");
  }

  window.addEventListener("message", function (e) {
    if (!e.data || typeof e.data !== "object") return;
    if (e.data.type === "wb:set-comments") applyComments(e.data.comments || []);
    if (e.data.type === "wb:set-active-comment") {
      // Clear previous active
      document.querySelectorAll("mark[data-wb-comment].active").forEach(function (el) {
        el.classList.remove("active");
      });
      const id = e.data.commentId;
      if (id !== null) {
        const mark = document.querySelector('mark[data-wb-comment="' + id + '"]');
        if (mark) {
          mark.classList.add("active");
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  });

  document.addEventListener("click", function (e) {
    const target = e.target;
    if (!target || !target.closest) return;
    const mark = target.closest("mark[data-wb-comment]");
    if (mark) {
      e.preventDefault();
      parent.postMessage({ type: "wb:mark-click", commentId: Number(mark.dataset.wbComment) }, "*");
      return;
    }
    const a = target.closest("a[href]");
    if (a && !e.defaultPrevented) {
      const href = a.getAttribute("href") || "";
      if (!href) return;
      // In-document anchor: scroll within the iframe instead of letting the
      // browser resolve "#id" against the parent page's URL (srcDoc inherits
      // the parent base URL, which would navigate the iframe to the app).
      if (href.startsWith("#")) {
        e.preventDefault();
        const id = decodeURIComponent(href.slice(1));
        if (!id) {
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        let dest = document.getElementById(id);
        if (!dest) {
          const named = document.getElementsByName(id);
          dest = named && named.length ? named[0] : null;
        }
        if (dest) dest.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (/^(?:[a-z]+:)|^\\/\\//i.test(href) || href.startsWith("mailto:")) {
        e.preventDefault();
        parent.postMessage({ type: "wb:open-external", href: href }, "*");
      } else {
        e.preventDefault();
        parent.postMessage({ type: "wb:open-relative", href: href }, "*");
      }
    }
  });

  parent.postMessage({ type: "wb:ready" }, "*");
})();
</script>
</body></html>`;
}

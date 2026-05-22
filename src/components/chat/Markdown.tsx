// Markdown renderer used for both assistant message bodies and the
// approval-card plan preview. Intentionally does NOT use rehype-raw —
// assistant messages can contain XML-like tags (e.g. <quote>, <file>) that
// React then warns about as unknown custom elements; skipHtml strips them
// cleanly. The custom `img` component lets the agent inline images and
// videos by extension or alt-text sizing hint.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v"]);

function extFromUrl(url: string): string {
  try {
    if (url.startsWith("data:")) return "";
    const parsed = new URL(url, "http://x");
    // /api/files/raw uses a `path` query param; fall back to the pathname.
    const pathParam = parsed.searchParams.get("path");
    const pathToCheck = pathParam || parsed.pathname;
    const idx = pathToCheck.lastIndexOf(".");
    return idx < 0 ? "" : pathToCheck.slice(idx + 1).toLowerCase();
  } catch {
    const idx = url.lastIndexOf(".");
    return idx < 0 ? "" : url.slice(idx + 1).split(/[?#]/)[0].toLowerCase();
  }
}

// Parse alt text for dimensions: "alt text|600" or "alt text|600x400"
function parseAltWithSize(alt?: string): { alt: string; width?: number; height?: number } {
  if (!alt) return { alt: "" };
  const match = alt.match(/^(.+?)\|(\d+)(?:x(\d+))?$/);
  if (match) {
    return {
      alt: match[1].trim(),
      width: parseInt(match[2], 10),
      height: match[3] ? parseInt(match[3], 10) : undefined,
    };
  }
  return { alt };
}

function MarkdownMedia({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  const ext = extFromUrl(src);
  const { alt: cleanAlt, width, height } = parseAltWithSize(alt);
  const style: React.CSSProperties = {};
  if (width) style.width = width;
  if (height) style.height = height;
  if (!width && !height) style.maxHeight = "400px";

  if (VIDEO_EXT.has(ext)) {
    return (
      <video
        src={src}
        controls
        className="max-w-full rounded-lg my-2"
        style={style}
      >
        {cleanAlt && <track kind="captions" label={cleanAlt} />}
      </video>
    );
  }
  return (
    <img
      src={src}
      alt={cleanAlt}
      className="max-w-full rounded-lg my-2"
      style={style}
    />
  );
}

const markdownComponents = {
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => (
    <MarkdownMedia src={typeof src === "string" ? src : undefined} alt={alt} />
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose max-w-none text-[14px] leading-relaxed prose-p:my-2 prose-pre:bg-[var(--panel-2)] prose-pre:border prose-pre:border-[var(--border)] prose-code:text-[var(--accent)] prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={markdownComponents}
      >{text}</ReactMarkdown>
    </div>
  );
}

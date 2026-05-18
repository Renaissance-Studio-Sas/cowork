// Resolve a relative href against the directory of a file path. Returns null
// for hrefs that aren't relative file paths (external URLs, anchors, mailto).
export function resolveRelative(currentFilePath: string, href: string): string | null {
  if (!href) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("mailto:")) return null;
  if (/^(?:[a-z]+:)|^\/\//i.test(href)) return null;

  const baseDir = currentFilePath.includes("/")
    ? currentFilePath.slice(0, currentFilePath.lastIndexOf("/"))
    : "";
  const parts = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

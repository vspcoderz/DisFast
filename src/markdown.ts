/**
 * Minimal markdown renderer: escapes HTML first, then applies a small set
 * of Discord-style patterns. Deliberately tiny — no parser library.
 * Output is safe for dangerouslySetInnerHTML because all input is escaped
 * before any tags are introduced.
 */
export function renderMarkdown(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/&gt; (.+)/g, "<blockquote>$1</blockquote>")
    .replace(/\n/g, "<br>");
}

import twemoji from "@twemoji/api";

const TWEMOJI_BASE = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/";

/**
 * Minimal markdown renderer: escapes HTML first, then applies a small set
 * of Discord-style patterns, then renders emoji:
 *  - custom server emoji (`<:name:id>` / `<a:name:id>`) → Discord CDN
 *  - unicode emoji → Twemoji images (what Discord itself uses)
 *
 * Output is safe for dangerouslySetInnerHTML because all input is escaped
 * before any tags are introduced.
 */
export function renderMarkdown(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const html = esc
    // Custom emoji (escaped form: &lt;:name:id&gt;)
    .replace(
      /&lt;(a?):(\w+):(\d+)&gt;/g,
      (_m, animated: string, name: string, id: string) =>
        `<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}" alt=":${name}:" title=":${name}:">`,
    )
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/&gt; (.+)/g, "<blockquote>$1</blockquote>")
    .replace(/\n/g, "<br>");

  // Unicode emoji → Twemoji <img> tags (runs last, on already-safe HTML;
  // it only matches emoji codepoints, never tags or entities).
  return twemoji.parse(html, {
    base: TWEMOJI_BASE,
    folder: "72x72",
    ext: ".png",
    className: "emoji",
  });
}

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
/**
 * Click-to-reveal spoilers. Registered once at module load; the HTML we
 * emit is already sanitized, so event delegation is safe.
 */
export function initSpoilers() {
  if (typeof document === "undefined") return;
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    const spoiler = target?.closest?.(".spoiler");
    spoiler?.classList.add("revealed");
  });
}

/**
 * Cheap pre-test: if the text has nothing that needs the full pipeline
 * (markdown markers, links, mentions, or emoji), skip the regex passes
 * and the Twemoji scan entirely. Embed-heavy channels hit this path for
 * most fields, and the full parser was costing ~8 regexes + a codepoint
 * classification per field per render.
 */
const NEEDS_FULL_PIPELINE =
  /[*_`~|#<>]|\]\(|https?:\/\/|&lt;[@#&]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

export function renderMarkdown(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Plain-text fast path: escaping above is sufficient when there's
  // nothing to interpret.
  if (!NEEDS_FULL_PIPELINE.test(text)) {
    return esc.replace(/\n/g, "<br>");
  }

  const html = esc
    // Custom emoji (escaped form: &lt;:name:id&gt;)
    .replace(
      /&lt;(a?):(\w+):(\d+)&gt;/g,
      (_m, animated: string, name: string, id: string) =>
        `<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}" alt=":${name}:" title=":${name}:">`,
    )
    // Mention/channel/role tokens must resolve before link parsing so a
      // token containing no URL is never touched. Discord sends them as
      // literal <@123>, which is already escaped to &lt;@123&gt;.
      .replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@$1</span>')
      .replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention role">@&amp;$1</span>')
      .replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#$1</span>')
      // Links. The lookbehind keeps bare-URL matching from re-linking a URL
      // that is already inside an href="..." we just generated.
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
      )
      .replace(
        /(^|[\s(])(https?:\/\/[^\s<)"']+)/g,
        '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>',
      )
      .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      // Spoiler blocks: ||hidden text||
      .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler">$1</span>')
      // Headings, Discord-style (bounded so they can't blow up the row)
      .replace(/^#{1,3}\s+(.+)$/gm, (_, h) => `<h3 class="md-h">${h}</h3>`)
      // Unordered + ordered lists
      .replace(/^[ \t]*[-*]\s+(.+)$/gm, "<li>$1</li>")
      .replace(/^(\d+)\.\s+(.+)$/gm, '<li class="md-ol">$2</li>')
      // Tables: | a | b |  with  |---|---| separator
      .replace(
        /\|([^\n|]+)\|\s*\n\|([-:\s|]+)\|\s*\n((?:\|[^\n|]+\|\s*\n?)+)/g,
        (_m, header: string, _sep: string, body: string) => {
          const head = header
            .split("|")
            .map((c) => `<th>${c.trim()}</th>`)
            .join("");
          const rows = body
            .trim()
            .split("\n")
            .map(
              (row) =>
                "<tr>" +
                row
                  .split("|")
                  .map((c) => `<td>${c.trim()}</td>`)
                  .join("") +
                "</tr>",
            )
            .join("");
          return `<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
        },
      )
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

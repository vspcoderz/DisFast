import { renderMarkdown } from "../markdown";
import type { Embed, MessageComponent } from "../types";

function hexColor(color?: number | null): string | undefined {
  return color != null ? `#${color.toString(16).padStart(6, "0")}` : undefined;
}

function Md({ text }: { text: string }) {
  // renderMarkdown escapes all input before introducing tags
  return <span dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

export function EmbedView({ embed }: { embed: Embed }) {
  // Non-rich embeds (images/gifs/videos) — just show the media or a link.
  if (embed.type === "image" || embed.type === "gifv") {
    const url = embed.image?.url ?? embed.thumbnail?.url ?? embed.url;
    const dim = embed.image ?? embed.thumbnail;
    return url ? (
      <img
        className="attachment-img"
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        width={dim?.width}
        height={dim?.height}
        style={
          dim?.width && dim?.height
            ? { aspectRatio: `${dim.width} / ${dim.height}` }
            : undefined
        }
      />
    ) : null;
  }
  if (embed.type === "video") {
    return embed.url ? (
      <a href={embed.url} target="_blank" rel="noreferrer">
        {embed.url}
      </a>
    ) : null;
  }

  return (
    <div className="embed" style={{ borderLeftColor: hexColor(embed.color) }}>
      {embed.author && (
        <div className="embed-author">
          {embed.author.icon_url && <img src={embed.author.icon_url} alt="" />}
          {embed.author.url ? (
            <a href={embed.author.url} target="_blank" rel="noreferrer">
              {embed.author.name}
            </a>
          ) : (
            <span>{embed.author.name}</span>
          )}
        </div>
      )}
      {embed.title &&
        (embed.url ? (
          <a className="embed-title" href={embed.url} target="_blank" rel="noreferrer">
            {embed.title}
          </a>
        ) : (
          <div className="embed-title">{embed.title}</div>
        ))}
      {embed.description && (
        <div className="embed-description">
          <Md text={embed.description} />
        </div>
      )}
      {embed.fields && embed.fields.length > 0 && (
        <div className="embed-fields">
          {embed.fields.map((f, i) => (
            <div key={i} className={`embed-field${f.inline ? " inline" : ""}`}>
              <div className="embed-field-name">{f.name}</div>
              <div className="embed-field-value">
                <Md text={f.value} />
              </div>
            </div>
          ))}
        </div>
      )}
      {embed.image && (
        <img
          className="embed-image"
          src={embed.image.url}
          alt=""
          loading="lazy"
          decoding="async"
          // Reserve the box up front: without intrinsic dimensions every
          // image load relayouts the whole message list, which is brutal in
          // channels that are mostly embeds.
          width={embed.image.width}
          height={embed.image.height}
          style={
            embed.image.width && embed.image.height
              ? { aspectRatio: `${embed.image.width} / ${embed.image.height}` }
              : undefined
          }
        />
      )}
      {embed.thumbnail && !embed.image && (
        <img
          className="embed-thumbnail"
          src={embed.thumbnail.url}
          alt=""
          loading="lazy"
          decoding="async"
          width={embed.thumbnail.width}
          height={embed.thumbnail.height}
        />
      )}
      {embed.footer && (
        <div className="embed-footer">
          {embed.footer.icon_url && <img src={embed.footer.icon_url} alt="" />}
          <span>{embed.footer.text}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Minimal Components V2 renderer. Unknown component types render their
 * children if present, otherwise nothing.
 */
/** Payload for a component interaction (button press, select change). */
export interface Interaction {
  customId: string;
  componentType: number;
  values: string[];
}

export function ComponentView({
  c,
  onInteract,
}: {
  c: MessageComponent;
  onInteract?: (i: Interaction) => void;
}) {
  switch (c.type) {
    case 1: // ActionRow
      return (
        <div className="cv2-row">
          {c.components?.map((child, i) => (
            <ComponentView key={i} c={child} onInteract={onInteract} />
          ))}
        </div>
      );
    case 2: // Button
      return c.url ? (
        <a className="cv2-button" href={c.url} target="_blank" rel="noreferrer">
          {c.label ?? c.url}
        </a>
      ) : (
        <button
          className="cv2-button"
          disabled={c.disabled}
          onClick={() =>
            onInteract
              ? onInteract({
                  customId: c.custom_id ?? "",
                  componentType: 2,
                  values: [],
                })
              : undefined
          }
        >
          {c.emoji && (
            c.emoji.id ? (
              <img
                src={`https://cdn.discordapp.com/emojis/${c.emoji.id}.${c.emoji.animated ? "gif" : "webp"}`}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="emoji">{c.emoji.name}</span>
            )
          )}
          {c.label ?? "Button"}
        </button>
      );
    case 3: // StringSelect
case 5: // UserSelect
case 6: // RoleSelect
case 7: // MentionableSelect
case 8: // ChannelSelect
    {
      const componentType = c.type;
      const selected = c.values ?? [];
      return (
        <div className="cv2-select-wrap">
          {selected.length > 0 && (
            <div className="cv2-select-values">
              {selected.map((v, i) => (
                <span key={i} className="cv2-pill">
                  {v}
                </span>
              ))}
            </div>
          )}
          <select
            className="cv2-select"
            defaultValue=""
            onChange={(e) => {
              if (!e.target.value || !c.custom_id) return;
              onInteract?.({
                customId: c.custom_id,
                componentType,
                values: [e.target.value],
              });
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              {c.placeholder ?? "Select an option…"}
            </option>
            {c.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case 9: // Section
      return (
        <div className="cv2-section">
          <div className="cv2-section-body">
            {c.components?.map((child, i) => (
              <ComponentView key={i} c={child} onInteract={onInteract} />
            ))}
          </div>
          {c.accessory && <ComponentView c={c.accessory} onInteract={onInteract} />}
        </div>
      );
    case 10: // TextDisplay
      return (
        <div className="content">
          <Md text={c.content ?? ""} />
        </div>
      );
    case 12: // MediaGallery
      return (
        <div className="cv2-gallery">
          {c.items?.map((item, i) => (
            <img key={i} className="attachment-img" src={item.media.url} alt={item.description ?? ""} loading="lazy" />
          ))}
        </div>
      );
    case 13: // File
      return c.file?.url ? (
        <a href={c.file.url} target="_blank" rel="noreferrer">
          {c.name ?? c.file.url}
        </a>
      ) : null;
    case 14: // Separator
      return c.divider === false ? <div className="cv2-gap" /> : <hr className="cv2-separator" />;
    case 17: // Container
      return (
        <div className="cv2-container" style={{ borderLeftColor: hexColor(c.accent_color) }}>
          {c.components?.map((child, i) => <ComponentView key={i} c={child} onInteract={onInteract} />)}
        </div>
      );
    default:
      return (
        <>
          {c.components?.map((child, i) => <ComponentView key={i} c={child} onInteract={onInteract} />)}
        </>
      );
  }
}

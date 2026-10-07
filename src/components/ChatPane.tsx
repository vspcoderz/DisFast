import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import { Link as LinkIcon, Paperclip, Pencil, Reply, Trash2 } from "lucide-react";
import { api, events } from "../api";
import { renderMarkdown } from "../markdown";
import { IS_COMPONENTS_V2, type Message } from "../types";
import { displayName, formatTime } from "../utils";
import type { ActiveChannel } from "./Main";
import { ComponentView, EmbedView, type Interaction } from "./RichContent";
import { Avatar } from "./Avatar";
import { LazyMedia } from "./LazyMedia";

/**
 * Discord groups consecutive messages from the same author within 7
 * minutes: no repeated avatar/name, just indented content. Without this
 * every row repeats its header and the log reads flat.
 */
const GROUP_WINDOW_MS = 7 * 60 * 1000;

function isGroupedWith(prev: Message | undefined, msg: Message): boolean {
  if (!prev) return false;
  if (prev.author.id !== msg.author.id) return false;
  // Replies always start their own group.
  if (prev.referenced_message || msg.referenced_message) return false;
  const dt = new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime();
  return dt >= 0 && dt < GROUP_WINDOW_MS;
}

// Memoized so a new incoming message doesn't re-render the whole history —
// the main source of "lag when messages arrive".
const MessageRow = memo(function MessageRow({
  msg,
  grouped,
  currentUserId,
  editing,
  onImageClick,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
  onReply,
  onCopyLink,
  onComponentInteract,
}: {
  msg: Message;
  grouped: boolean;
  currentUserId: string;
  editing: boolean;
  onImageClick: (url: string) => void;
  onStartEdit: (m: Message) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (m: Message, content: string) => void;
  onDelete: (m: Message) => void;
  onReply: (m: Message) => void;
  onCopyLink: (m: Message) => void;
  onComponentInteract: (i: Interaction) => void;
}) {
  const isV2 = ((msg.flags ?? 0) & IS_COMPONENTS_V2) !== 0;
  const reply = msg.referenced_message;
  const isMine = msg.author.id === currentUserId;
  const onInteract = onComponentInteract;

  return (
    <div
      className={`message${grouped ? " grouped" : ""}`}
      data-id={msg.id}
      role="listitem"
    >
      {grouped ? (
        // Timestamp appears in the left gutter only on hover, in the space
        // the avatar column already reserves.
        <span className="hover-time">{formatTime(msg.timestamp)}</span>
      ) : (
        <Avatar user={msg.author} size={40} />
      )}
      <div className="body">
        {!grouped && (
          <div className="meta">
            <span className="author">{displayName(msg.author)}</span>
            <span className="time">{formatTime(msg.timestamp)}</span>
            {msg.edited_timestamp && (
              <span className="edited" title="Edited">
                (edited)
              </span>
            )}
          </div>
        )}

        {/* Hover action bar */}
        <div className="message-actions">
          <button className="message-action" title="Reply" onClick={() => onReply(msg)}>
            <Reply size={16} />
          </button>
          <button className="message-action" title="Copy link" onClick={() => onCopyLink(msg)}>
            <LinkIcon size={16} />
          </button>
          {isMine && (
            <button className="message-action" title="Edit" onClick={() => onStartEdit(msg)}>
              <Pencil size={16} />
            </button>
          )}
          {isMine && (
            <button className="message-action danger" title="Delete" onClick={() => onDelete(msg)}>
              <Trash2 size={16} />
            </button>
          )}
        </div>

        {editing ? (
          <EditBox
            initial={msg.content}
            onCancel={onCancelEdit}
            onSubmit={(content) => onSubmitEdit(msg, content)}
          />
        ) : (
          <>
        {reply && (
          <div className="reply-ref">
            <span className="reply-author">{displayName(reply.author)}</span>
            <span className="reply-content">
              {reply.content || (reply.attachments?.length ? "📎 Attachment" : "")}
            </span>
          </div>
        )}
        {msg.content ? (
          <div
            className="content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        ) : null}
        {(msg.components?.length ?? 0) > 0 &&
          msg.components?.map((c, i) => (
            <ComponentView key={i} c={c} onInteract={onInteract} />
          ))}
        {(msg.embeds?.length ?? 0) > 0 && (
          <LazyMedia>
            {msg.embeds!.map((embed, i) => (
              <EmbedView key={i} embed={embed} />
            ))}
          </LazyMedia>
        )}
        {(msg.attachments ?? []).length > 0 && (
          <LazyMedia>
            {msg.attachments!.map((att) =>
              att.content_type?.startsWith("image/") ? (
                <img
                  key={att.id}
                  className="attachment-img"
                  src={att.url}
                  alt={att.filename}
                  loading="lazy"
                  decoding="async"
                  onClick={() => onImageClick(att.url)}
                  style={
                    att.width && att.height
                      ? { aspectRatio: `${att.width} / ${att.height}` }
                      : undefined
                  }
                />
              ) : (
                <a key={att.id} href={att.url} target="_blank" rel="noreferrer">
                  {att.filename}
                </a>
              ),
            )}
          </LazyMedia>
        )}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className="reactions">
            {msg.reactions.map((r, i) => (
              <button
                key={i}
                className={`reaction${r.me ? " me" : ""}`}
                title={r.emoji.name ?? r.emoji.id ?? ""}
                onClick={() =>
                  r.me
                    ? api.removeReaction(msg.channel_id, msg.id, emojiKey(r.emoji))
                    : api.addReaction(msg.channel_id, msg.id, emojiKey(r.emoji))
                }
              >
                {r.emoji.name ? (
                  r.emoji.name
                ) : (
                  <img
                    src={`https://cdn.discordapp.com/emojis/${r.emoji.id}.png`}
                    alt=""
                    loading="lazy"
                  />
                )}
                <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
});

function emojiKey(emoji: { id: string | null; name: string | null }): string {
  return emoji.name ?? (emoji.id ?? "");
}

/** Inline editor for an existing message. */
function EditBox({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="edit-box">
      <textarea
        autoFocus
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit(value.trim());
          }
        }}
      />
      <div className="edit-hint">
        escape to <button className="linkish" onClick={onCancel}>cancel</button> •{" "}
        enter to <button className="linkish" onClick={() => onSubmit(value.trim())}>save</button>
      </div>
    </div>
  );
}

interface Props {
  channel: ActiveChannel;
  query: string;
  currentUserId: string;
  sendTyping?: boolean;
}

export function ChatPane({
  channel,
  query,
  currentUserId,
  sendTyping: sendTypingProp,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [draft, setDraft] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  // Typing can be disabled in settings; sync the prop into local state so
  // the guard in notifyTyping reads it without re-subscribing listeners.
  const sendTyping = sendTypingProp ?? true;
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [typingUsers, setTypingUsers] = useState<Map<string, number>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadingHistory = useRef(false);
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const pendingAnchor = useRef<number | null>(null);
  const lastTypingSent = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initial load. The API returns newest first; we store oldest→newest.
  useEffect(() => {
    let alive = true;
    api
      .getMessages(channel.id)
      .then((msgs) => {
        if (!alive) return;
        setMessages(msgs.reverse());
        setHasMore(msgs.length === 50);
        requestAnimationFrame(() => {
          const list = listRef.current;
          if (list) list.scrollTop = list.scrollHeight;
        });
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [channel.id]);

  // Live gateway events for this channel.
  useEffect(() => {
    const unlisteners = [
      events.onMessageCreate((msg) => {
        if (msg.channel_id !== channel.id) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      }),
      // Embeds typically arrive a moment after creation via MESSAGE_UPDATE.
      events.onMessageUpdate((update) => {
        if (update.channel_id !== channel.id) return;
        setMessages((prev) =>
          prev.map((m) => (m.id === update.id ? { ...m, ...update } : m)),
        );
      }),
      events.onMessageDelete(({ id, channel_id }) => {
        if (channel_id !== channel.id) return;
        setMessages((prev) => prev.filter((m) => m.id !== id));
      }),
      events.onMessageDeleteBulk(({ ids, channel_id }) => {
        if (channel_id !== channel.id) return;
        const gone = new Set(ids);
        setMessages((prev) => prev.filter((m) => !gone.has(m.id)));
      }),
      // Someone else reacting to a message we're showing.
      events.onMessageReaction((p) => {
        if (p.channel_id !== channel.id) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== p.message_id) return m;
            const reactions = [...(m.reactions ?? [])];
            const key = emojiKey(p.emoji);
            const idx = reactions.findIndex((r) => emojiKey(r.emoji) === key);
            if (idx === -1) return m;
            if (p.user_id === currentUserId) {
              // Our own toggle is already handled optimistically by the
              // button; the gateway event is the confirmation.
              return m;
            }
            // We can't tell add from remove without the event name, so
            // reconcile against the count Discord sends in MESSAGE_UPDATE.
            return m;
          }),
        );
      }),
      events.onTypingStart((p) => {
        if (p.channel_id !== channel.id || p.user_id === currentUserId) return;
        const now = Date.now();
        setTypingUsers((prev) => {
          const next = new Map(prev);
          next.set(p.user_id, now);
          return next;
        });
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [channel.id, currentUserId]);

  // Expire typing indicators after Discord's 10s window.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 10000;
      setTypingUsers((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map<string, number>();
        for (const [id, ts] of prev) if (ts > cutoff) next.set(id, ts);
        return next.size === prev.size ? prev : next;
      });
    }, 2000);
    return () => clearInterval(t);
  }, []);

  // Keep scrolled to the bottom when new messages arrive and the user
  // hasn't scrolled up.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (pendingAnchor.current != null) {
      list.scrollTop += list.scrollHeight - pendingAnchor.current;
      pendingAnchor.current = null;
    } else if (stickToBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  async function loadOlder() {
    if (loadingHistory.current || !hasMore || !messages.length) return;
    loadingHistory.current = true;
    const list = listRef.current;
    try {
      const older = await api.getMessages(channel.id, messages[0].id);
      if (!older.length) {
        setHasMore(false);
        return;
      }
      older.reverse();
      if (list) pendingAnchor.current = list.scrollHeight;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !seen.has(m.id)), ...prev];
      });
    } catch (e) {
      console.error("history load failed:", e);
    } finally {
      loadingHistory.current = false;
    }
  }

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    stickToBottom.current =
      list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    // Only trigger when actively scrolling *up* — not on programmatic
    // scroll changes (initial render starts at scrollTop 0).
    if (list.scrollTop < 100 && list.scrollTop < lastScrollTop.current) {
      loadOlder();
    }
    lastScrollTop.current = list.scrollTop;
  }

  /** Read a File as base64 (stripping the data-URL prefix) for the Rust side. */
function readAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function send() {
    const content = draft.trim();
    if (!content && pendingFiles.length === 0) return;
    setDraft("");
    stickToBottom.current = true;

    // Attachments go up first (one request per file), then the message
    // text rides along with the first attachment.
    if (pendingFiles.length > 0) {
      setUploading(true);
      try {
        const first = pendingFiles[0];
        const data = await readAsBase64(first);
        await api.uploadAttachment(channel.id, first.name, data);
        if (content) {
          await api.sendMessage(channel.id, content, replyTo?.id);
        }
        // Extras upload as their own messages (Discord's client does the
        // same for multi-file past the first).
        for (const extra of pendingFiles.slice(1)) {
          const d = await readAsBase64(extra);
          await api.uploadAttachment(channel.id, extra.name, d);
        }
        setPendingFiles([]);
        setReplyTo(null);
      } catch (e) {
        setDraft(content);
        setToast(String(e));
      } finally {
        setUploading(false);
      }
      return;
    }

    try {
      await api.sendMessage(channel.id, content, replyTo?.id);
      setReplyTo(null);
      // The gateway echoes the message back via message-create.
    } catch (e) {
      setDraft(content); // restore on failure
      console.error("send failed:", e);
    }
  }

  /** Paste images straight into the composer. */
  function onPaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData.items);
    const files = items
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f != null);
    if (files.length > 0) {
      e.preventDefault();
      setPendingFiles((prev) => [...prev, ...files]);
    }
  }

  /** Discord's typing indicator expires after 10s; send at most every 8. */
  function notifyTyping() {
    if (!sendTyping) return;
    const now = Date.now();
    if (now - lastTypingSent.current < 8000) return;
    lastTypingSent.current = now;
    api.sendTyping(channel.id).catch(() => {});
  }

  async function submitEdit(msg: Message, content: string) {
    if (!content || content === msg.content) {
      setEditingId(null);
      return;
    }
    try {
      await api.editMessage(channel.id, msg.id, content);
      setEditingId(null);
    } catch (e) {
      setToast(String(e));
      setEditingId(null);
    }
  }

  async function remove(msg: Message) {
    try {
      await api.deleteMessage(channel.id, msg.id);
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    } catch (e) {
      setToast(String(e));
    }
  }

  /** discord.com/channels/{guild}/{channel}/{message} — omit guild for DMs. */
  /** Buttons/selects go over gateway op 3; Discord answers with a MESSAGE_UPDATE. */
  async function interact(msg: Message, i: Interaction) {
    const appId =
      msg.application?.id ??
      Object.values(msg.interaction_metadata?.authorizing_integration_owners ?? {})[0]
        ?.application_id;
    if (!appId) {
      setToast("This interaction can't be sent from a third-party client.");
      return;
    }
    try {
      await api.interactComponent({
        applicationId: appId,
        channelId: channel.id,
        messageId: msg.id,
        guildId: msg.guild_id ?? null,
        componentType: i.componentType,
        customId: i.customId,
        values: i.values,
      });
    } catch (e) {
      setToast(String(e));
    }
  }

  function copyLink(msg: Message) {
    const guildPart = msg.guild_id ? msg.guild_id : "@me";
    navigator.clipboard
      .writeText(`https://discord.com/channels/${guildPart}/${channel.id}/${msg.id}`)
      .then(() => {
        setToast("Message link copied");
        setTimeout(() => setToast(null), 1500);
      })
      .catch(() => setToast("Could not copy link"));
  }

  // Client-side search over the loaded conversation (server-side search
  // with paging is a Phase 2 feature).
  /**
 * Derive grouping once per messages change instead of during render.
 *
 * `visible[i-1]` during render made every row's output depend on its
 * predecessor, which defeated the memo on MessageRow: prepending history
 * re-rendered the whole list, and each row re-ran the markdown regexes.
 * Now row i depends only on messages[i-1], so appends render one row.
 */
  const rows = useMemo(() => {
    const out: Array<{ msg: Message; grouped: boolean }> = [];
    for (const msg of messages) {
      out.push({ msg, grouped: isGroupedWith(out[out.length - 1]?.msg, msg) });
    }
    return out;
  }, [messages]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (q ? rows.filter((r) => r.msg.content.toLowerCase().includes(q)) : rows),
    [rows, q],
  );

  return (
    <main className="chat-pane">
      <div className="message-list" ref={listRef} onScroll={onScroll}>
        {!hasMore && messages.length > 0 && !q && (
          <div className="history-start">Beginning of conversation</div>
        )}
        {q && <div className="history-start">{visible.length} result{visible.length === 1 ? "" : "s"}</div>}
        {visible.map((r) => (
          <MessageRow
            key={r.msg.id}
            msg={r.msg}
            grouped={r.grouped}
            currentUserId={currentUserId}
            editing={editingId === r.msg.id}
            onImageClick={setLightbox}
            onStartEdit={(m) => setEditingId(m.id)}
            onCancelEdit={() => setEditingId(null)}
            onSubmitEdit={submitEdit}
            onDelete={remove}
            onReply={(m) => {
              setReplyTo(m);
              document.querySelector<HTMLInputElement>(".composer input")?.focus();
            }}
            onCopyLink={copyLink}
            onComponentInteract={(i) => interact(row.msg, i)}
          />
        ))}
        {typingUsers.size > 0 && (
          <div className="typing-indicator">
            <span className="typing-dots">
              <i /><i /><i />
            </span>
            {typingUsers.size === 1 ? "someone is typing…" : "several people are typing…"}
          </div>
        )}
      </div>
      <div className="composer">
        {replyTo && (
          <div className="reply-bar">
            <Reply size={14} />
            <span className="reply-bar-text">
              Replying to <strong>{displayName(replyTo.author)}</strong>
            </span>
            <button className="reply-bar-close" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              ✕
            </button>
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="pending-files">
            {pendingFiles.map((f, i) => (
              <div key={`${f.name}-${i}`} className="pending-file">
                <Paperclip size={12} />
                <span className="pending-file-name">{f.name}</span>
                <span className="pending-file-size">
                  {(f.size / 1024).toFixed(0)} KB
                </span>
                <button
                  className="pending-file-remove"
                  onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${f.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button
            className="composer-attach icon-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach a file"
            aria-label="Attach a file"
          >
            <Paperclip size={20} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) setPendingFiles((prev) => [...prev, ...files]);
              e.target.value = "";
            }}
          />
          <input
            type="text"
            placeholder={
              uploading ? "Uploading…" : `Message ${channel.name}`
            }
            autoComplete="off"
            value={draft}
            disabled={uploading}
            onPaste={onPaste}
            onChange={(e) => {
              setDraft(e.target.value);
              notifyTyping();
            }}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          />
        </div>
      </div>
      {toast && <div className="chat-toast">{toast}</div>}
      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          tabIndex={-1}
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="" />
        </div>
      )}
    </main>
  );
}

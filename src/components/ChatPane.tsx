import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, events } from "../api";
import { Avatar } from "./Avatar";
import { renderMarkdown } from "../markdown";
import { IS_COMPONENTS_V2, type Message } from "../types";
import { displayName, formatTime } from "../utils";
import type { ActiveChannel } from "./Main";
import { ComponentView, EmbedView } from "./RichContent";

// Memoized so a new incoming message doesn't re-render the whole history —
// the main source of "lag when messages arrive".
const MessageRow = memo(function MessageRow({ msg }: { msg: Message }) {
  const isV2 = ((msg.flags ?? 0) & IS_COMPONENTS_V2) !== 0;
  return (
    <div className="message" data-id={msg.id}>
      <Avatar user={msg.author} size={38} />
      <div className="body">
        <div className="meta">
          <span className="author">{displayName(msg.author)}</span>
          <span className="time">{formatTime(msg.timestamp)}</span>
        </div>
        {msg.content ? (
          <div
            className="content"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        ) : null}
        {isV2 && msg.components?.map((c, i) => <ComponentView key={i} c={c} />)}
        {msg.embeds?.map((embed, i) => <EmbedView key={i} embed={embed} />)}
        {(msg.attachments ?? []).map((att) =>
          att.content_type?.startsWith("image/") ? (
            <img
              key={att.id}
              className="attachment-img"
              src={att.url}
              alt={att.filename}
              loading="lazy"
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
      </div>
    </div>
  );
});

interface Props {
  channel: ActiveChannel;
  /** Search query from the header (owned by Main). */
  query: string;
}

export function ChatPane({ channel, query }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const loadingHistory = useRef(false);
  const stickToBottom = useRef(true);
  const lastScrollTop = useRef(0);
  // Set when we prepend history; applied after React commits the DOM so
  // the viewport stays anchored on the same message.
  const pendingAnchor = useRef<number | null>(null);

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
    ];
    return () => {
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [channel.id]);

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

  async function send() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    stickToBottom.current = true;
    try {
      await api.sendMessage(channel.id, content);
      // The gateway echoes the message back via message-create.
    } catch (e) {
      setDraft(content); // restore on failure
      console.error("send failed:", e);
    }
  }

  // Client-side search over the loaded conversation (server-side search
  // with paging is a Phase 2 feature).
  const q = query.trim().toLowerCase();
  const visible = q
    ? messages.filter((m) => m.content.toLowerCase().includes(q))
    : messages;

  return (
    <main className="chat-pane">
      <div className="message-list" ref={listRef} onScroll={onScroll}>
        {!hasMore && messages.length > 0 && !q && (
          <div className="history-start">Beginning of conversation</div>
        )}
        {q && <div className="history-start">{visible.length} result{visible.length === 1 ? "" : "s"}</div>}
        {visible.map((m) => (
          <MessageRow key={m.id} msg={m} />
        ))}
      </div>
      <div className="composer">
        <input
          type="text"
          placeholder={`Message ${channel.name}`}
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
      </div>
    </main>
  );
}

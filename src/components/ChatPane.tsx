import { useEffect, useRef, useState } from "react";
import { api, events } from "../api";
import { renderMarkdown } from "../markdown";
import type { Message } from "../types";
import { avatarUrl, displayName, formatTime } from "../utils";
import type { ActiveChannel } from "./Main";

function MessageRow({ msg }: { msg: Message }) {
  return (
    <div className="message" data-id={msg.id}>
      <img className="avatar" src={avatarUrl(msg.author)} alt="" loading="lazy" />
      <div className="body">
        <div className="meta">
          <span className="author">{displayName(msg.author)}</span>
          <span className="time">{formatTime(msg.timestamp)}</span>
        </div>
        {/* renderMarkdown escapes all input before introducing tags */}
        <div
          className="content"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content || "") }}
        />
        {(msg.attachments ?? []).map((att) =>
          att.content_type?.startsWith("image/") ? (
            <img
              key={att.id}
              className="attachment-img"
              src={att.url}
              alt={att.filename}
              loading="lazy"
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
}

export function ChatPane({ channel }: { channel: ActiveChannel }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const loadingHistory = useRef(false);
  const stickToBottom = useRef(true);

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
        if (stickToBottom.current) {
          requestAnimationFrame(() => {
            const list = listRef.current;
            if (list) list.scrollTop = list.scrollHeight;
          });
        }
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

  async function loadOlder() {
    if (loadingHistory.current || !hasMore || !messages.length) return;
    loadingHistory.current = true;
    const list = listRef.current;
    const prevHeight = list?.scrollHeight ?? 0;
    try {
      const older = await api.getMessages(channel.id, messages[0].id);
      if (!older.length) {
        setHasMore(false);
        return;
      }
      older.reverse();
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !seen.has(m.id)), ...prev];
      });
      // Keep the viewport anchored on the same message after prepending.
      requestAnimationFrame(() => {
        if (list) list.scrollTop += list.scrollHeight - prevHeight;
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
    if (list.scrollTop < 100) loadOlder();
  }

  async function send() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    try {
      await api.sendMessage(channel.id, content);
      // The gateway echoes the message back via message-create.
    } catch (e) {
      setDraft(content); // restore on failure
      console.error("send failed:", e);
    }
  }

  return (
    <main className="chat-pane">
      <header className="chat-header">{channel.name}</header>
      <div className="message-list" ref={listRef} onScroll={onScroll}>
        {!hasMore && messages.length > 0 && (
          <div className="history-start">Beginning of conversation</div>
        )}
        {messages.map((m) => (
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

import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, PanelRight, Phone, Pin, Search, UserPlus, Video } from "lucide-react";
import { api, events } from "../api";
import type { Channel, Guild, GuildSelection, User } from "../types";
import { GuildSidebar } from "./GuildSidebar";
import { ChannelPane, type DmTarget } from "./ChannelPane";
import { ChatPane } from "./ChatPane";
import { ProfilePanel } from "./ProfilePanel";

export interface ActiveChannel {
  id: string;
  name: string;
  /** Set for 1:1 DMs — enables the profile side panel. */
  recipientId?: string;
  /** Avatar URL for 1:1 DMs, shown in the chat header. */
  recipientAvatar?: string;
  /** Username for 1:1 DMs, used in the search placeholder. */
  recipientUsername?: string;
}

function channelKey(ch: ActiveChannel): string {
  return ch.id;
}

/** Most recently active first, like the official client. */
function sortDmsByActivity(list: Channel[]): Channel[] {
  return [...list].sort((a, b) => {
    const ai = BigInt(a.last_message_id ?? "0");
    const bi = BigInt(b.last_message_id ?? "0");
    return ai === bi ? 0 : ai > bi ? -1 : 1;
  });
}

export function Main({ user }: { user: User }) {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [dms, setDms] = useState<Channel[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeGuild, setActiveGuild] = useState<GuildSelection>("dm");
  const [activeChannel, setActiveChannel] = useState<ActiveChannel | null>(null);
  const [paneOpen, setPaneOpen] = useState(false);
  const [showProfile, setShowProfile] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  /** Unread counts per channel + guilds with any unread. */
  const [unreadChannels, setUnreadChannels] = useState<Record<string, number>>({});
  const [unreadGuilds, setUnreadGuilds] = useState<Set<string>>(new Set());
  // Ref mirror so the global message listener always sees the current channel
  const activeChannelRef = useRef<ActiveChannel | null>(null);
  activeChannelRef.current = activeChannel;

  // Load guild list once.
  useEffect(() => {
    api.getGuilds().then(setGuilds).catch((e) => setError(String(e)));
  }, []);

  // Load DMs (they arrive via the gateway READY, so also refresh then).
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .getDms()
        .then((d) => alive && setDms(sortDmsByActivity(d)))
        .catch(() => {});
    refresh();
    const unlisteners = [
      events.onGatewayReady(refresh),
      events.onDmCreate((ch) => {
        if (ch.type === 1 || ch.type === 3) {
          setDms((prev) =>
            prev.some((c) => c.id === ch.id) ? prev : [...prev, ch],
          );
        }
      }),
      events.onDmDelete((ch) => {
        setDms((prev) => prev.filter((c) => c.id !== ch.id));
      }),
      events.onGatewayClosed((reason) => setError(`gateway closed: ${reason}`)),
    ];
    return () => {
      alive = false;
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  // Global live sync: any incoming message, in any channel.
  // (ChatPane separately handles messages for the open channel.)
  useEffect(() => {
    const unlisten = events.onMessageCreate((msg) => {
      // DM channels jump to the top of the list on activity.
      if (msg.guild_id == null) {
        setDms((prev) => {
          const i = prev.findIndex((c) => c.id === msg.channel_id);
          if (i <= 0) return prev;
          const next = [...prev];
          const [ch] = next.splice(i, 1);
          next.unshift(ch);
          return next;
        });
      }
      // No unread badge for your own messages or the open channel.
      if (msg.author.id === user.id) return;
      if (msg.channel_id === activeChannelRef.current?.id) return;
      setUnreadChannels((prev) => ({
        ...prev,
        [msg.channel_id]: (prev[msg.channel_id] ?? 0) + 1,
      }));
      if (msg.guild_id) {
        setUnreadGuilds((prev) => new Set(prev).add(String(msg.guild_id)));
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [user.id]);

  const selectGuild = useCallback(async (sel: GuildSelection) => {
    setActiveGuild(sel);
    setActiveChannel(null);
    if (sel === "dm") return; // DM list is already loaded
    // Opening a guild clears its unread dot.
    setUnreadGuilds((prev) => {
      if (!prev.has(sel)) return prev;
      const next = new Set(prev);
      next.delete(sel);
      return next;
    });
    try {
      setChannels(await api.getChannels(sel));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const selectChannel = useCallback((id: string, name: string, dm?: DmTarget) => {
    setActiveChannel({ id, name, ...dm });
    setShowProfile(true);
    setQuery("");
    setPaneOpen(false); // auto-close the overlay pane on narrow screens
    // Opening a channel clears its unread count.
    setUnreadChannels((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const guild = guilds.find((g) => g.id === activeGuild) ?? null;
  const recipientId = activeChannel?.recipientId;
  const profileVisible = recipientId != null && showProfile;

  return (
    <div
      className={`app-view${paneOpen ? " pane-open" : ""}${profileVisible ? " with-profile" : ""}`}
    >
      <GuildSidebar
        guilds={guilds}
        activeGuild={activeGuild}
        unreadGuilds={unreadGuilds}
        onSelect={selectGuild}
      />
      <ChannelPane
        selection={activeGuild}
        guild={guild}
        dms={dms}
        channels={channels}
        activeChannelId={activeChannel?.id ?? null}
        unreadChannels={unreadChannels}
        user={user}
        onSelect={selectChannel}
      />

      {/* Header spans the chat + profile columns, so the search bar sits
          directly above the profile card like the official client */}
      <header className="chat-header">
        <button
          className="pane-toggle icon-btn"
          onClick={() => setPaneOpen((v) => !v)}
          title="Channels"
        >
          <Menu size={18} />
        </button>
        {activeChannel?.recipientAvatar && (
          <img className="chat-header-avatar" src={activeChannel.recipientAvatar} alt="" />
        )}
        <span className="chat-header-name">
          {activeChannel?.name ?? "Select a channel"}
        </span>
        {activeChannel && (
          <div className="chat-header-actions">
            <button className="icon-btn" disabled title="Voice calls — coming in Phase 4">
              <Phone size={18} />
            </button>
            <button className="icon-btn" disabled title="Video calls — coming in Phase 4">
              <Video size={18} />
            </button>
            <button className="icon-btn" disabled title="Pinned messages — coming soon">
              <Pin size={18} />
            </button>
            <button className="icon-btn" disabled title="Add friends to DM — coming soon">
              <UserPlus size={18} />
            </button>
            {recipientId && (
              <button
                className="icon-btn"
                onClick={() => setShowProfile((v) => !v)}
                title="Toggle profile panel"
              >
                <PanelRight size={18} />
              </button>
            )}
            <div className="chat-search">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${activeChannel.recipientUsername ?? activeChannel.name.replace(/^#\s*/, "")}`}
              />
              <Search size={14} className="chat-search-icon" />
            </div>
          </div>
        )}
      </header>

      {activeChannel ? (
        <ChatPane key={channelKey(activeChannel)} channel={activeChannel} query={query} />
      ) : (
        <main className="chat-pane" />
      )}

      {profileVisible && <ProfilePanel userId={recipientId} />}
      {error && <div className="error-toast">{error}</div>}
    </div>
  );
}

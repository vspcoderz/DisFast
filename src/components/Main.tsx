import { useCallback, useEffect, useState } from "react";
import { Menu } from "lucide-react";
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

export function Main({ user }: { user: User }) {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [dms, setDms] = useState<Channel[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeGuild, setActiveGuild] = useState<GuildSelection>("dm");
  const [activeChannel, setActiveChannel] = useState<ActiveChannel | null>(null);
  const [paneOpen, setPaneOpen] = useState(false);
  const [error, setError] = useState("");

  // Load guild list once.
  useEffect(() => {
    api.getGuilds().then(setGuilds).catch((e) => setError(String(e)));
  }, []);

  // Load DMs (they arrive via the gateway READY, so also refresh then).
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api.getDms().then((d) => alive && setDms(d)).catch(() => {});
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

  const selectGuild = useCallback(async (sel: GuildSelection) => {
    setActiveGuild(sel);
    setActiveChannel(null);
    if (sel === "dm") return; // DM list is already loaded
    try {
      setChannels(await api.getChannels(sel));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const [showProfile, setShowProfile] = useState(true);

  const selectChannel = useCallback((id: string, name: string, dm?: DmTarget) => {
    setActiveChannel({ id, name, ...dm });
    setShowProfile(true);
    setPaneOpen(false); // auto-close the overlay pane on narrow screens
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
        onSelect={selectGuild}
      />
      <ChannelPane
        selection={activeGuild}
        guild={guild}
        dms={dms}
        channels={channels}
        activeChannelId={activeChannel?.id ?? null}
        user={user}
        onSelect={selectChannel}
      />
      {activeChannel ? (
        <ChatPane
          key={channelKey(activeChannel)}
          channel={activeChannel}
          onTogglePane={() => setPaneOpen((v) => !v)}
          onToggleProfile={recipientId ? () => setShowProfile((v) => !v) : undefined}
        />
      ) : (
        <main className="chat-pane">
          <header className="chat-header">
            <button className="pane-toggle icon-btn" onClick={() => setPaneOpen((v) => !v)} title="Channels">
              <Menu size={18} />
            </button>
            <span className="chat-header-name">Select a channel</span>
          </header>
        </main>
      )}
      {profileVisible && <ProfilePanel userId={recipientId} />}
      {error && <div className="error-toast">{error}</div>}
    </div>
  );
}

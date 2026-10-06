import { useCallback, useEffect, useState } from "react";
import { api, events } from "../api";
import type { Channel, Guild, GuildSelection, User } from "../types";
import { GuildSidebar } from "./GuildSidebar";
import { ChannelPane } from "./ChannelPane";
import { ChatPane } from "./ChatPane";

export interface ActiveChannel {
  id: string;
  name: string;
}

export function Main({ user }: { user: User }) {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [dms, setDms] = useState<Channel[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeGuild, setActiveGuild] = useState<GuildSelection>("dm");
  const [activeChannel, setActiveChannel] = useState<ActiveChannel | null>(null);
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

  const selectChannel = useCallback((id: string, name: string) => {
    setActiveChannel({ id, name });
  }, []);

  const guild = guilds.find((g) => g.id === activeGuild) ?? null;

  return (
    <div className="app-view">
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
        <ChatPane key={activeChannel.id} channel={activeChannel} />
      ) : (
        <main className="chat-pane">
          <header className="chat-header">Select a channel</header>
        </main>
      )}
      {error && <div className="error-toast">{error}</div>}
    </div>
  );
}

import type { Channel, Guild, GuildSelection, User } from "../types";
import { avatarUrl, displayName, dmChannelName } from "../utils";

interface Props {
  selection: GuildSelection;
  guild: Guild | null;
  dms: Channel[];
  channels: Channel[];
  activeChannelId: string | null;
  user: User;
  onSelect: (id: string, name: string) => void;
}

export function ChannelPane({
  selection,
  guild,
  dms,
  channels,
  activeChannelId,
  user,
  onSelect,
}: Props) {
  const isDm = selection === "dm";
  const textChannels = channels
    .filter((c) => c.type === 0)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  return (
    <aside className="channel-pane">
      <header className="guild-header">
        {isDm ? "Direct Messages" : (guild?.name ?? "DisFast")}
      </header>
      <div className="channel-list">
        {isDm
          ? dms.map((ch) => {
              const name = dmChannelName(ch);
              return (
                <div
                  key={ch.id}
                  className={`channel-item${activeChannelId === ch.id ? " active" : ""}`}
                  onClick={() => onSelect(ch.id, name)}
                >
                  {name}
                </div>
              );
            })
          : textChannels.map((ch) => (
              <div
                key={ch.id}
                className={`channel-item${activeChannelId === ch.id ? " active" : ""}`}
                onClick={() => onSelect(ch.id, `# ${ch.name}`)}
              >
                # {ch.name}
              </div>
            ))}
      </div>
      <footer className="user-bar">
        <img src={avatarUrl(user)} alt="" />
        <span>{displayName(user)}</span>
      </footer>
    </aside>
  );
}

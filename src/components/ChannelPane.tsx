import type { Channel, GatewayStatus, Guild, GuildSelection, User } from "../types";
import { avatarUrl, displayName, dmChannelName } from "../utils";

export interface DmTarget {
  recipientId?: string;
  recipientAvatar?: string;
  recipientUsername?: string;
  isGroupDm?: boolean;
  recipients?: User[];
}

interface Props {
  selection: GuildSelection;
  guild: Guild | null;
  dms: Channel[];
  channels: Channel[];
  activeChannelId: string | null;
  unreadChannels: Record<string, number>;
  gatewayStatus: GatewayStatus;
  user: User;
  onSelect: (id: string, name: string, dm?: DmTarget) => void;
}

function UnreadBadge({ count }: { count?: number }) {
  if (!count) return null;
  return <span className="unread-badge">{count > 99 ? "99+" : count}</span>;
}

export function ChannelPane({
  selection,
  guild,
  dms,
  channels,
  activeChannelId,
  unreadChannels,
  gatewayStatus,
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
              // 1:1 DMs (type 1) enable the profile panel; group DMs (type 3)
              // enable the members panel
              const recipient = ch.type === 1 ? ch.recipients?.[0] : undefined;
              const isGroupDm = ch.type === 3;
              const unread = unreadChannels[ch.id];
              return (
                <div
                  key={ch.id}
                  className={`channel-item${activeChannelId === ch.id ? " active" : ""}${unread ? " unread" : ""}`}
                  onClick={() =>
                    onSelect(
                      ch.id,
                      name,
                      isGroupDm
                        ? { isGroupDm: true, recipients: ch.recipients ?? [] }
                        : recipient && {
                            recipientId: recipient.id,
                            recipientAvatar: avatarUrl(recipient),
                            recipientUsername: recipient.username,
                          },
                    )
                  }
                >
                  <span className="channel-name">{name}</span>
                  <UnreadBadge count={unread} />
                </div>
              );
            })
          : textChannels.map((ch) => {
              const unread = unreadChannels[ch.id];
              return (
                <div
                  key={ch.id}
                  className={`channel-item${activeChannelId === ch.id ? " active" : ""}${unread ? " unread" : ""}`}
                  onClick={() => onSelect(ch.id, `# ${ch.name}`)}
                >
                  <span className="channel-name"># {ch.name}</span>
                  <UnreadBadge count={unread} />
                </div>
              );
            })}
      </div>
      <footer className="user-bar">
        <span className={`status-dot ${gatewayStatus}`} title={`Gateway: ${gatewayStatus}`} />
        <img src={avatarUrl(user)} alt="" />
        <span>{displayName(user)}</span>
      </footer>
    </aside>
  );
}

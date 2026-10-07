import { Lock, Settings } from "lucide-react";
import type { Channel, GatewayStatus, Guild, GuildSelection, User } from "../types";
import { avatarUrl, displayName, dmChannelName } from "../utils";
import { Avatar } from "./Avatar";

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
  /** Presence status from the settings store. */
  statusText: string;
  user: User;
  onSelect: (id: string, name: string, dm?: DmTarget) => void;
  onOpenSettings: () => void;
}

function UnreadBadge({ count }: { count?: number }) {
  if (!count) return null;
  return <span className="unread-badge">{count > 99 ? "99+" : count}</span>;
}

/**
 * A channel is read-only when the server says we lack SEND_MESSAGES.
 * The Rust side resolves the full overwrite chain (roles + categories),
 * so we just read its verdict rather than re-deriving permissions here.
 */
function isLocked(ch: Channel): boolean {
  return ch.can_send === false;
}

export function ChannelPane({
  selection,
  guild,
  dms,
  channels,
  activeChannelId,
  unreadChannels,
  gatewayStatus,
  statusText,
  user,
  onSelect,
  onOpenSettings,
}: Props) {
  const isDm = selection === "dm";
  const textChannels = channels
    .filter((c) => c.type === 0)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  // Group text channels by their parent category
  const categories = new Map<string, Channel[]>();
  const uncategorized: Channel[] = [];
  for (const ch of textChannels) {
    const parentId = ch.parent_id;
    if (parentId) {
      const list = categories.get(parentId) ?? [];
      list.push(ch);
      categories.set(parentId, list);
    } else {
      uncategorized.push(ch);
    }
  }
  // Category names from the channel list itself (type 4)
  const categoryName = (id: string): string =>
    channels.find((c) => c.id === id)?.name ?? "Category";

  const renderChannel = (ch: Channel) => {
    const unread = unreadChannels[ch.id];
    const locked = isLocked(ch);
    return (
      <div
        key={ch.id}
        className={`channel-item${activeChannelId === ch.id ? " active" : ""}${unread ? " unread" : ""}`}
        onClick={() => onSelect(ch.id, `# ${ch.name}`)}
      >
        <span className="channel-name"># {ch.name}</span>
        {locked && <Lock size={12} className="channel-lock" />}
        <UnreadBadge count={unread} />
      </div>
    );
  };

  return (
    <aside className="channel-pane">
      <header className="guild-header">
        {isDm ? "Direct Messages" : (guild?.name ?? "DisFast")}
      </header>
      <div className="channel-list">
        {isDm ? (
          dms.map((ch) => {
            const name = dmChannelName(ch);
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
                {recipient && <Avatar user={recipient} size={24} />}
                <span className="channel-name">{name}</span>
                <UnreadBadge count={unread} />
              </div>
            );
          })
        ) : (
          <>
            {uncategorized.map(renderChannel)}
            {Array.from(categories.entries()).map(([catId, chs]) => (
              <div key={catId} className="channel-category">
                <div className="channel-category-name">{categoryName(catId)}</div>
                {chs.map(renderChannel)}
              </div>
            ))}
          </>
        )}
      </div>
      <footer className="user-bar">
        <div className="user-bar-main">
          <div className="user-bar-avatar">
            <Avatar user={user} size={30} />
            <span
              className={`status-dot ${gatewayStatus}`}
              title={`Gateway: ${gatewayStatus}`}
            />
          </div>
          <span className="user-bar-names">
            <span className="user-bar-name">{displayName(user)}</span>
            <span className="user-bar-status">{statusText}</span>
          </span>
        </div>
        <button
          className="user-bar-btn"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Open settings"
        >
          <Settings size={16} />
        </button>
      </footer>
    </aside>
  );
}

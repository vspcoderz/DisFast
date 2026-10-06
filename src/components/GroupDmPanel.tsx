import { useState } from "react";
import { api } from "../api";
import type { User } from "../types";
import { avatarUrl, displayName } from "../utils";

interface Props {
  channelId: string;
  name: string;
  members: User[];
}

export function GroupDmPanel({ channelId, name, members }: Props) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function invite() {
    if (busy) return;
    setBusy(true);
    try {
      const invite = await api.createInvite(channelId);
      await navigator.clipboard.writeText(`https://discord.gg/${invite.code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("invite failed:", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="profile-panel group-dm-panel">
      <div className="group-dm-header">
        <div className="group-dm-name">{name}</div>
        <div className="group-dm-count">Members—{members.length}</div>
      </div>
      <div className="member-list">
        {members.map((m) => (
          <div key={m.id} className="member-item">
            <img className="member-avatar" src={avatarUrl(m)} alt="" loading="lazy" />
            <span className="member-name">{displayName(m)}</span>
          </div>
        ))}
      </div>
      <button className="invite-button" onClick={invite} disabled={busy}>
        {busy ? "Creating…" : copied ? "Invite link copied!" : "Invite to Group DM"}
      </button>
    </aside>
  );
}

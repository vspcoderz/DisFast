import { useEffect, useState } from "react";
import { api } from "../api";
import type { User } from "../types";
import { displayName } from "../utils";
import { Avatar } from "./Avatar";

interface Member {
  user: User;
  nick: string | null;
  roles: string[];
}

interface Role {
  id: string;
  name: string;
  color: number | null;
  position: number;
}

export function MemberSidebar({ guildId }: { guildId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.getMembers(guildId), api.getRoles(guildId)])
      .then(([m, r]) => {
        if (!alive) return;
        setMembers(m);
        setRoles(r);
      })
      .catch(console.error)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [guildId]);

  if (loading) {
    return <aside className="member-sidebar loading">Loading members…</aside>;
  }

  // Group members by their highest-position role
  const roleMap = new Map<string, Role>();
  for (const r of roles) roleMap.set(r.id, r);

  const groups = new Map<string, Member[]>();
  const online: Member[] = [];

  for (const m of members) {
    // Highest position role the member has
    let best: Role | null = null;
    for (const roleId of m.roles) {
      const role = roleMap.get(roleId);
      if (role && (!best || role.position > best.position)) {
        best = role;
      }
    }
    if (best) {
      const list = groups.get(best.id) ?? [];
      list.push(m);
      groups.set(best.id, list);
    } else {
      online.push(m);
    }
  }

  // Sort groups by role position (highest first)
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    const ra = roleMap.get(a[0]);
    const rb = roleMap.get(b[0]);
    return (rb?.position ?? 0) - (ra?.position ?? 0);
  });

  const renderMember = (m: Member) => {
    const name = m.nick ?? displayName(m.user);
    return (
      <div key={m.user.id} className="member-row">
        <Avatar user={m.user} size={32} />
        <span className="member-name">{name}</span>
      </div>
    );
  };

  return (
    <aside className="member-sidebar">
      {sortedGroups.map(([roleId, groupMembers]) => {
        const role = roleMap.get(roleId);
        return (
          <div key={roleId} className="member-group">
            <div
              className="member-group-title"
              style={
                role?.color != null
                  ? { color: `#${role.color.toString(16).padStart(6, "0")}` }
                  : undefined
              }
            >
              {role?.name ?? "Members"} — {groupMembers.length}
            </div>
            {groupMembers.map(renderMember)}
          </div>
        );
      })}
      {online.length > 0 && (
        <div className="member-group">
          <div className="member-group-title">Online — {online.length}</div>
          {online.map(renderMember)}
        </div>
      )}
    </aside>
  );
}

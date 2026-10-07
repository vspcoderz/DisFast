import { useState } from "react";
import type { Guild, GuildSelection } from "../types";
import { guildIconUrl, initials } from "../utils";

export interface GuildFolder {
  id: string;
  name: string;
  guildIds: string[];
}

/**
 * Folders live in localStorage: Discord's /users/@me/guild-folders
 * endpoint returns 404, so there is nothing to sync with server-side.
 */
const FOLDERS_KEY = "disfast.guildFolders";

function loadFolders(): GuildFolder[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    return raw ? (JSON.parse(raw) as GuildFolder[]) : [];
  } catch {
    return [];
  }
}

interface Props {
  guilds: Guild[];
  activeGuild: GuildSelection;
  unreadGuilds: Set<string>;
  onSelect: (sel: GuildSelection) => void;
}

export function GuildSidebar({ guilds, activeGuild, unreadGuilds, onSelect }: Props) {
  const [folders, setFolders] = useState<GuildFolder[]>(loadFolders);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem("disfast.collapsedFolders") ?? "[]")),
  );

  const persist = (next: GuildFolder[]) => {
    setFolders(next);
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
  };

  const persistCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    localStorage.setItem("disfast.collapsedFolders", JSON.stringify([...next]));
  };

  // Guilds not placed in any folder render loose, at the top.
  const inFolder = new Set(folders.flatMap((f) => f.guildIds));
  const loose = guilds.filter((g) => !inFolder.has(g.id));

  const renderGuild = (g: Guild) => {
    const icon = guildIconUrl(g);
    return (
      <div
        key={g.id}
        className={`guild-icon${activeGuild === g.id ? " active" : ""}`}
        title={g.name}
        onClick={() => onSelect(g.id)}
        onContextMenu={(e) => {
          // Right-click a server to add it to (or create) a folder.
          e.preventDefault();
          const existing = folders.find((f) =>
            f.guildIds.includes(g.id),
          );
          if (existing) {
            persist(
              folders.map((f) =>
                f.id === existing.id
                  ? { ...f, guildIds: f.guildIds.filter((x) => x !== g.id) }
                  : f,
              ),
            );
            return;
          }
          const name = prompt("Folder name:", g.name.slice(0, 12));
          if (!name) return;
          persist([
            ...folders,
            { id: `f${Date.now()}`, name, guildIds: [g.id] },
          ]);
        }}
      >
        {icon ? <img src={icon} alt={g.name} loading="lazy" /> : initials(g.name)}
        {unreadGuilds.has(g.id) && <span className="guild-dot" />}
      </div>
    );
  };

  return (
    <nav className="guild-sidebar">
      <div
        className={`guild-icon${activeGuild === "dm" ? " active" : ""}`}
        title="Direct Messages"
        onClick={() => onSelect("dm")}
      >
        DM
      </div>
      {loose.map(renderGuild)}
      {folders.map((folder) => {
        const members = guilds.filter((g) => folder.guildIds.includes(g.id));
        const isCollapsed = collapsed.has(folder.id);
        return (
          <div key={folder.id} className="guild-folder">
            <button
              className="guild-folder-label"
              onClick={() => {
                const next = new Set(collapsed);
                if (next.has(folder.id)) next.delete(folder.id);
                else next.add(folder.id);
                persistCollapsed(next);
              }}
              title={folder.name}
            >
              {folder.name.slice(0, 16)}
            </button>
            {!isCollapsed && members.map(renderGuild)}
          </div>
        );
      })}
    </nav>
  );
}

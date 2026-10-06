import type { Guild, GuildSelection } from "../types";
import { guildIconUrl, initials } from "../utils";

interface Props {
  guilds: Guild[];
  activeGuild: GuildSelection;
  onSelect: (sel: GuildSelection) => void;
}

export function GuildSidebar({ guilds, activeGuild, onSelect }: Props) {
  return (
    <nav className="guild-sidebar">
      <div
        className={`guild-icon${activeGuild === "dm" ? " active" : ""}`}
        title="Direct Messages"
        onClick={() => onSelect("dm")}
      >
        DM
      </div>
      {guilds.map((g) => {
        const icon = guildIconUrl(g);
        return (
          <div
            key={g.id}
            className={`guild-icon${activeGuild === g.id ? " active" : ""}`}
            title={g.name}
            onClick={() => onSelect(g.id)}
          >
            {icon ? <img src={icon} alt={g.name} loading="lazy" /> : initials(g.name)}
          </div>
        );
      })}
    </nav>
  );
}

export interface User {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface Guild {
  id: string;
  name: string;
  icon: string | null;
}

export interface Channel {
  id: string;
  /** 0 = guild text, 1 = DM, 3 = group DM, 2 = voice, 4 = category */
  type: number;
  name: string | null;
  position?: number;
  recipients?: User[];
  /** Snowflake of the most recent message — used to sort DMs by activity. */
  last_message_id?: string | null;
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  content_type?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface Embed {
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string; width?: number; height?: number };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

/**
 * Message components (incl. Components V2), typed loosely — Discord adds
 * new component types faster than clients can type them.
 * Common types: 1 ActionRow, 2 Button, 9 Section, 10 TextDisplay,
 * 12 MediaGallery, 13 File, 14 Separator, 17 Container.
 */
export interface MessageComponent {
  type: number;
  content?: string;
  label?: string;
  url?: string;
  disabled?: boolean;
  divider?: boolean;
  name?: string;
  accent_color?: number | null;
  components?: MessageComponent[];
  accessory?: MessageComponent;
  items?: { media: { url: string }; description?: string }[];
  file?: { url: string };
}

export interface Message {
  id: string;
  channel_id: string;
  /** Present on guild messages, absent on DMs. */
  guild_id?: string | null;
  content: string;
  timestamp: string;
  author: User;
  attachments: Attachment[];
  embeds?: Embed[];
  components?: MessageComponent[];
  /** bit 15 (1 << 15) = IS_COMPONENTS_V2 */
  flags?: number;
}

/** MESSAGE_UPDATE payloads are partial — only changed fields are present. */
export type MessageUpdatePayload = Partial<Message> & {
  id: string;
  channel_id: string;
};

export interface MessageDeletePayload {
  id: string;
  channel_id: string;
}

export type GuildSelection = "dm" | string;

/** Gateway connection state, shown as a status dot in the user bar. */
export type GatewayStatus = "connecting" | "reconnecting" | "ready" | "failed";

export const IS_COMPONENTS_V2 = 1 << 15;

/** Response of GET /users/{id}/profile */
export interface UserProfileResponse {
  user: User & {
    banner?: string | null;
    accent_color?: number | null;
    bot?: boolean;
    /** Avatar decoration (animated overlay) */
    avatar_decoration_data?: {
      asset: string;
      sku_id: string;
      expires_at: string | null;
    } | null;
    /** Clan / primary guild badge */
    clan?: {
      identity_guild_id: string;
      identity_enabled: boolean;
      tag: string;
      badge: string;
    } | null;
  };
  /** 0 = none, 1 = Nitro Classic, 2 = Nitro, 3 = Nitro Basic */
  premium_type?: number;
  premium_since?: string | null;
  user_profile?: {
    bio?: string;
    accent_color?: number | null;
    banner?: string | null;
    pronouns?: string;
    theme_colors?: number[];
  };
}

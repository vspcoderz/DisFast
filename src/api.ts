import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Channel,
  GatewayStatus,
  Guild,
  Message,
  MessageDeletePayload,
  MessageUpdatePayload,
  User,
  UserProfileResponse,
} from "./types";

/**
 * Typed boundary over the Rust commands. Arg names are camelCase here;
 * Tauri converts them to the snake_case Rust parameters. All IDs are
 * strings — JS numbers can't hold Discord's 64-bit snowflakes safely.
 */
export const api = {
  login: (token: string) => invoke<User>("login", { token }),
  getGuilds: () => invoke<Guild[]>("get_guilds"),
  getDms: () => invoke<Channel[]>("get_dms"),
  getChannels: (guildId: string) =>
    invoke<Channel[]>("get_channels", { guildId }),
  getMessages: (channelId: string, before?: string) =>
    invoke<Message[]>("get_messages", { channelId, before }),
  sendMessage: (channelId: string, content: string) =>
    invoke<Message>("send_message", { channelId, content }),
  getUserProfile: (userId: string) =>
    invoke<UserProfileResponse>("get_user_profile", { userId }),
  createInvite: (channelId: string) =>
    invoke<{ code: string }>("create_invite", { channelId }),
  addReaction: (channelId: string, messageId: string, emoji: string) =>
    invoke<void>("add_reaction", { channelId, messageId, emoji }),
  removeReaction: (channelId: string, messageId: string, emoji: string) =>
    invoke<void>("remove_reaction", { channelId, messageId, emoji }),
  getMembers: (guildId: string) =>
    invoke<Array<{ user: User; nick: string | null; roles: string[] }>>("get_members", { guildId }),
  getRoles: (guildId: string) =>
    invoke<Array<{ id: string; name: string; color: number | null; position: number }>>("get_roles", { guildId }),
  /** Debug builds only; null in release. */
  getDevToken: () => invoke<string | null>("get_dev_token"),
};

export const events = {
  onMessageCreate: (cb: (msg: Message) => void): Promise<UnlistenFn> =>
    listen<Message>("message-create", (e) => cb(e.payload)),
  onMessageDelete: (
    cb: (payload: MessageDeletePayload) => void,
  ): Promise<UnlistenFn> =>
    listen<MessageDeletePayload>("message-delete", (e) => cb(e.payload)),
  onMessageUpdate: (
    cb: (payload: MessageUpdatePayload) => void,
  ): Promise<UnlistenFn> =>
    listen<MessageUpdatePayload>("message-update", (e) => cb(e.payload)),
  onGatewayReady: (cb: () => void): Promise<UnlistenFn> =>
    listen("gateway-ready", () => cb()),
  onGatewayStatus: (cb: (status: GatewayStatus) => void): Promise<UnlistenFn> =>
    listen<GatewayStatus>("gateway-status", (e) => cb(e.payload)),
  onGatewayClosed: (cb: (reason: string) => void): Promise<UnlistenFn> =>
    listen<string>("gateway-closed", (e) => cb(e.payload)),
  onDmCreate: (cb: (ch: Channel) => void): Promise<UnlistenFn> =>
    listen<Channel>("dm-create", (e) => cb(e.payload)),
  onDmDelete: (cb: (ch: Channel) => void): Promise<UnlistenFn> =>
    listen<Channel>("dm-delete", (e) => cb(e.payload)),
};

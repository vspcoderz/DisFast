import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AuthResult,
  Channel,
  GatewayStatus,
  Guild,
  Message,
  MessageDeletePayload,
  MessageUpdatePayload,
  TypingStartPayload,
  MessageReactionPayload,
  TypingStartPayload,
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
  sendMessage: (channelId: string, content: string, replyTo?: string) =>
    invoke<Message>("send_message", { channelId, content, replyTo: replyTo ?? null }),
  editMessage: (channelId: string, messageId: string, content: string) =>
    invoke<Message>("edit_message", { channelId, messageId, content }),
  deleteMessage: (channelId: string, messageId: string) =>
    invoke<void>("delete_message", { channelId, messageId }),
  sendTyping: (channelId: string) => invoke<void>("send_typing", { channelId }),
  interactComponent: (args: {
    applicationId: string;
    channelId: string;
    messageId: string;
    guildId?: string | null;
    componentType: number;
    customId: string;
    values?: string[];
  }) =>
    invoke<void>("interact_component", {
      applicationId: args.applicationId,
      channelId: args.channelId,
      messageId: args.messageId,
      guildId: args.guildId ?? null,
      componentType: args.componentType,
      customId: args.customId,
      values: args.values ?? [],
    }),
  uploadAttachment: (channelId: string, filename: string, dataBase64: string) =>
    invoke<Message>("upload_attachment", { channelId, filename, dataBase64 }),
  getPins: (channelId: string) =>
    invoke<{ items: { pinned_at: string; message: Message }[]; has_more: boolean }>(
      "get_pins",
      { channelId },
    ),
  addPin: (channelId: string, messageId: string) =>
    invoke<void>("add_pin", { channelId, messageId }),
  removePin: (channelId: string, messageId: string) =>
    invoke<void>("remove_pin", { channelId, messageId }),
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
  authLogin: (login: string, password: string) =>
    invoke<AuthResult>("auth_login", { login, password }),
  authMfaTotp: (ticket: string, code: string) =>
    invoke<AuthResult>("auth_mfa_totp", { ticket, code }),
};

export const events = {
  onMessageCreate: (cb: (msg: Message) => void): Promise<UnlistenFn> =>
    listen<Message>("message-create", (e) => cb(e.payload)),
  onMessageDelete: (
    cb: (payload: MessageDeletePayload) => void,
  ): Promise<UnlistenFn> =>
    listen<MessageDeletePayload>("message-delete", (e) => cb(e.payload)),
  onMessageDeleteBulk: (
    cb: (payload: { ids: string[]; channel_id: string }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ ids: string[]; channel_id: string }>("message-delete-bulk", (e) =>
      cb(e.payload),
    ),
  onMessageReaction: (cb: (payload: MessageReactionPayload) => void): Promise<UnlistenFn> =>
    listen<MessageReactionPayload>("message-reaction", (e) => cb(e.payload)),
  onTypingStart: (cb: (payload: TypingStartPayload) => void): Promise<UnlistenFn> =>
    listen<TypingStartPayload>("typing-start", (e) => cb(e.payload)),
  onChannelPinsUpdate: (
    cb: (payload: { channel_id: string; guild_id?: string | null }) => void,
  ): Promise<UnlistenFn> =>
    listen("channel-pins-update", (e) => cb(e.payload)),
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

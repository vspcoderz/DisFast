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
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  content_type?: string | null;
}

export interface Message {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: User;
  attachments: Attachment[];
}

export interface MessageDeletePayload {
  id: string;
  channel_id: string;
}

export type GuildSelection = "dm" | string;

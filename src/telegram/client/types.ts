export type PeerKind = "channel" | "supergroup" | "forum";

export interface Peer {
  chatId: number;
  kind: PeerKind;
}

export interface User {
  id: number;
  name: string;
}

export interface Thread {
  chatId: number;
  rootMessageId: number;
}

export interface Author {
  id: number;
  username: string | null;
  name: string;
}

export interface Message {
  kind: "message";
  id: number;
  replyToMessageId: number;
  author: Author | null;
  text: string;
  postedAt: Date;
  editedAt: Date | null;
}

export interface Deleted {
  kind: "deleted";
  id: number;
}

export interface Page {
  messages: Message[];
}

export interface Sent {
  messageId: number;
  postedAt: Date;
}

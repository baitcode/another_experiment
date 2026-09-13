import type { Deleted, Message, Page, Peer, Sent, Thread, User } from "./types.ts";

/** The six calls of the internal Telegram library. All ids are bare integers, all dates UTC. */
export interface TelegramClient {
  resolvePeer(ref: string | number): Promise<Peer>;
  resolveUser(username: string): Promise<User>;
  getDiscussionThread(channelId: number, messageId: number): Promise<Thread>;
  getThreadMessages(
    chatId: number,
    rootMessageId: number,
    minId: number,
    limit: number,
  ): Promise<Page>;
  getMessages(chatId: number, ids: number[]): Promise<(Message | Deleted)[]>;
  sendReply(
    chatId: number,
    replyToMessageId: number,
    text: string,
    topicId: number | null,
  ): Promise<Sent>;
}

/** `for_user`: a handle for one account. Rejects with UserNotFound or Upstream. */
export type TelegramClientProvider = (username: string) => Promise<TelegramClient>;

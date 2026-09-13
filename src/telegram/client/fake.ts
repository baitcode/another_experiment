import type { TelegramClient } from "./client.ts";
import {
  MessageNotFound,
  NoDiscussionGroup,
  PeerNotFound,
  TelegramError,
  UserNotFound,
} from "./errors.ts";
import type { Deleted, Message, Page, Peer, Sent, Thread, User } from "./types.ts";

export interface FakeMessageInput {
  id: number;
  replyToMessageId: number;
  text: string;
  author?: Message["author"];
  postedAt?: Date;
  editedAt?: Date | null;
}

interface FakeThread {
  chatId: number;
  rootMessageId: number;
  messages: Map<number, Message>;
}

function threadKey(chatId: number, rootMessageId: number): string {
  return `${String(chatId)}:${String(rootMessageId)}`;
}

/** In-memory Telegram world shared by every client the factory hands out. */
export class FakeTelegram {
  readonly accounts = new Map<string, User>();
  readonly peers = new Map<string, Peer>();
  readonly discussions = new Map<string, Thread>();
  readonly threads = new Map<string, FakeThread>();
  readonly calls: string[] = [];
  private pendingFailure: TelegramError | null = null;
  private nextId = 1000;
  clock: () => Date = () => new Date();

  addAccount(username: string, user: User): void {
    this.accounts.set(username, user);
  }

  addPeer(ref: string | number, peer: Peer): void {
    this.peers.set(String(ref), peer);
  }

  linkDiscussion(channelId: number, messageId: number, thread: Thread): void {
    this.discussions.set(threadKey(channelId, messageId), thread);
    this.addThread(thread.chatId, thread.rootMessageId);
  }

  addThread(chatId: number, rootMessageId: number): void {
    const key = threadKey(chatId, rootMessageId);
    if (!this.threads.has(key)) {
      this.threads.set(key, { chatId, rootMessageId, messages: new Map() });
    }
  }

  addMessage(chatId: number, rootMessageId: number, input: FakeMessageInput): Message {
    this.addThread(chatId, rootMessageId);
    const thread = this.threads.get(threadKey(chatId, rootMessageId));
    if (thread === undefined) throw new Error("unreachable");
    const message: Message = {
      kind: "message",
      id: input.id,
      replyToMessageId: input.replyToMessageId,
      author: input.author ?? {
        id: 500 + input.id,
        username: `user${String(input.id)}`,
        name: `User ${String(input.id)}`,
      },
      text: input.text,
      postedAt: input.postedAt ?? this.clock(),
      editedAt: input.editedAt ?? null,
    };
    thread.messages.set(message.id, message);
    this.nextId = Math.max(this.nextId, message.id + 1);
    return message;
  }

  /** Edits a stored message the way a Telegram user would: new text and edit date. */
  editMessage(chatId: number, messageId: number, text: string, editedAt: Date): void {
    const found = this.findMessage(chatId, messageId);
    if (found === null) throw new Error(`no message ${String(messageId)}`);
    found.thread.messages.set(messageId, { ...found.message, text, editedAt });
  }

  deleteMessage(chatId: number, messageId: number): void {
    const found = this.findMessage(chatId, messageId);
    if (found !== null) found.thread.messages.delete(messageId);
  }

  failNext(error: TelegramError): void {
    this.pendingFailure = error;
  }

  forUser(username: string): Promise<TelegramClient> {
    this.calls.push(`forUser(${username})`);
    const failure = this.takeFailure();
    if (failure !== null) return Promise.reject(failure);
    const user = this.accounts.get(username);
    if (user === undefined) return Promise.reject(new UserNotFound(username));
    return Promise.resolve(new FakeClient(this, username, user));
  }

  takeFailure(): TelegramError | null {
    const f = this.pendingFailure;
    this.pendingFailure = null;
    return f;
  }

  allocateId(): number {
    return this.nextId++;
  }

  findMessage(chatId: number, messageId: number): { thread: FakeThread; message: Message } | null {
    for (const thread of this.threads.values()) {
      if (thread.chatId !== chatId) continue;
      const message = thread.messages.get(messageId);
      if (message !== undefined) return { thread, message };
    }
    return null;
  }
}

class FakeClient implements TelegramClient {
  constructor(
    private readonly world: FakeTelegram,
    private readonly username: string,
    private readonly self: User,
  ) {}

  private guard(call: string): Promise<void> {
    this.world.calls.push(call);
    const failure = this.world.takeFailure();
    return failure === null ? Promise.resolve() : Promise.reject(failure);
  }

  async resolvePeer(ref: string | number): Promise<Peer> {
    await this.guard(`resolvePeer(${String(ref)})`);
    const peer = this.world.peers.get(String(ref));
    if (peer === undefined) throw new PeerNotFound(String(ref));
    return peer;
  }

  async resolveUser(username: string): Promise<User> {
    await this.guard(`resolveUser(${username})`);
    const user = this.world.accounts.get(username);
    if (user === undefined) throw new PeerNotFound(username);
    return user;
  }

  async getDiscussionThread(channelId: number, messageId: number): Promise<Thread> {
    await this.guard(`getDiscussionThread(${String(channelId)}, ${String(messageId)})`);
    const thread = this.world.discussions.get(threadKey(channelId, messageId));
    if (thread !== undefined) return thread;
    const hasAnyDiscussion = [...this.world.discussions.keys()].some((k) =>
      k.startsWith(`${String(channelId)}:`)
    );
    if (!hasAnyDiscussion) throw new NoDiscussionGroup(channelId);
    throw new MessageNotFound(channelId, messageId);
  }

  async getThreadMessages(
    chatId: number,
    rootMessageId: number,
    minId: number,
    limit: number,
  ): Promise<Page> {
    await this.guard(
      `getThreadMessages(${String(chatId)}, ${String(rootMessageId)}, ${String(minId)}, ${
        String(limit)
      })`,
    );
    const thread = this.world.threads.get(threadKey(chatId, rootMessageId));
    if (thread === undefined) throw new MessageNotFound(chatId, rootMessageId);
    const messages = [...thread.messages.values()]
      .filter((m) => m.id > minId)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.min(limit, 100));
    return { messages };
  }

  async getMessages(chatId: number, ids: number[]): Promise<(Message | Deleted)[]> {
    await this.guard(`getMessages(${String(chatId)}, [${ids.join(",")}])`);
    return ids.map((id) => {
      const found = this.world.findMessage(chatId, id);
      return found === null ? { kind: "deleted", id } : found.message;
    });
  }

  async sendReply(
    chatId: number,
    replyToMessageId: number,
    text: string,
    topicId: number | null,
  ): Promise<Sent> {
    await this.guard(
      `sendReply(${String(chatId)}, ${String(replyToMessageId)}, ${JSON.stringify(text)}, ${
        String(topicId)
      })`,
    );
    const target = this.world.findMessage(chatId, replyToMessageId);
    if (target === null) throw new MessageNotFound(chatId, replyToMessageId);
    const message: Message = {
      kind: "message",
      id: this.world.allocateId(),
      replyToMessageId,
      author: { id: this.self.id, username: this.username, name: this.self.name },
      text,
      postedAt: this.world.clock(),
      editedAt: null,
    };
    target.thread.messages.set(message.id, message);
    return { messageId: message.id, postedAt: message.postedAt };
  }
}

/** A small world for the local environment: account `demo`, channel `demo_channel`, one post with two comments. */
export function seedDemo(fake: FakeTelegram): void {
  fake.addAccount("demo", { id: 42, name: "Demo Account" });
  fake.addPeer("demo_channel", { chatId: 1001, kind: "channel" });
  fake.addPeer(1001, { chatId: 1001, kind: "channel" });
  fake.addPeer("demo_group", { chatId: 2002, kind: "supergroup" });
  fake.addPeer(2002, { chatId: 2002, kind: "supergroup" });
  fake.linkDiscussion(1001, 1, { chatId: 2002, rootMessageId: 10 });
  fake.addMessage(2002, 10, { id: 11, replyToMessageId: 10, text: "first!" });
  fake.addMessage(2002, 10, { id: 12, replyToMessageId: 11, text: "no, second" });
}

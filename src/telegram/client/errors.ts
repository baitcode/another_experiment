export type TelegramErrorKind =
  | "user_not_found"
  | "peer_not_found"
  | "no_discussion_group"
  | "message_not_found"
  | "forbidden"
  | "flood_wait"
  | "session_invalid"
  | "upstream";

export abstract class TelegramError extends Error {
  abstract readonly kind: TelegramErrorKind;
}

export class UserNotFound extends TelegramError {
  readonly kind = "user_not_found";
  constructor(readonly username: string) {
    super(`user ${username} not found`);
  }
}

export class PeerNotFound extends TelegramError {
  readonly kind = "peer_not_found";
  constructor(readonly ref: string) {
    super(`peer ${ref} not found`);
  }
}

export class NoDiscussionGroup extends TelegramError {
  readonly kind = "no_discussion_group";
  constructor(readonly channelId: number) {
    super(`channel ${String(channelId)} has no discussion group`);
  }
}

export class MessageNotFound extends TelegramError {
  readonly kind = "message_not_found";
  constructor(readonly chatId: number, readonly messageId: number) {
    super(`message ${String(messageId)} in chat ${String(chatId)} not found`);
  }
}

export class Forbidden extends TelegramError {
  readonly kind = "forbidden";
}

export class FloodWait extends TelegramError {
  readonly kind = "flood_wait";
  constructor(readonly retryAfter: number) {
    super(`FLOOD_WAIT_${String(retryAfter)}`);
  }
}

export class SessionInvalid extends TelegramError {
  readonly kind = "session_invalid";
}

export class Upstream extends TelegramError {
  readonly kind = "upstream";
}

export function isTelegramError(e: unknown): e is TelegramError {
  return e instanceof TelegramError;
}

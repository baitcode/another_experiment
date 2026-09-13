import { HttpError } from "../../api/errors.ts";
import {
  FloodWait,
  Forbidden,
  isTelegramError,
  MessageNotFound,
  NoDiscussionGroup,
  PeerNotFound,
  SessionInvalid,
  type TelegramError,
  Upstream,
  UserNotFound,
} from "../client/errors.ts";

/**
 * `isTelegramError` narrows to the abstract `TelegramError` base type, which erases each
 * subclass's own fields (e.g. `FloodWait.retryAfter`). This is the union of its only
 * subclasses, so switching on `.kind` narrows `e` to the right one in each case.
 */
type AnyTelegramError =
  | UserNotFound
  | PeerNotFound
  | NoDiscussionGroup
  | MessageNotFound
  | Forbidden
  | FloodWait
  | SessionInvalid
  | Upstream;

function widen(e: TelegramError): AnyTelegramError {
  return e as AnyTelegramError;
}

/** Submit context of the spec's error table. Non-library errors pass through. */
export function translateSubmitError(e: unknown, ctx: { username: string }): never {
  if (!isTelegramError(e)) throw e;
  const err = widen(e);
  switch (err.kind) {
    case "user_not_found":
      throw new HttpError(404, "user_not_found", `user ${ctx.username} not found`);
    case "peer_not_found":
      throw new HttpError(400, "channel_not_found", "url does not resolve to a channel or group");
    case "no_discussion_group":
      throw new HttpError(
        400,
        "no_discussion_group",
        "channel has no discussion group, so the post has no comment thread",
      );
    case "message_not_found":
      throw new HttpError(
        400,
        "message_not_found",
        "url does not point at a message with a discussion thread",
      );
    case "forbidden":
      throw new HttpError(502, "upstream_failure", "telegram refused the call", {
        upstream_error: err.message,
      });
    case "flood_wait":
      throw new HttpError(
        500,
        "flood_wait",
        `telegram asks to wait ${String(err.retryAfter)} seconds`,
        {
          reason: err.message,
          retry_after: err.retryAfter,
        },
      );
    case "session_invalid":
      throw new HttpError(
        500,
        "session_invalid",
        `telegram session for ${ctx.username} is not valid`,
        {
          reason: err.message,
        },
      );
    case "upstream":
      throw new HttpError(502, "upstream_failure", "tg api timeout", {
        upstream_error: err.message,
      });
  }
}

/** Reply context. `message_not_found` is handled by the reply handler before this is reached, but is mapped for exhaustiveness. */
export function translateReplyError(
  e: unknown,
  ctx: { username: string; commentId: string },
): never {
  if (!isTelegramError(e)) throw e;
  const err = widen(e);
  switch (err.kind) {
    case "user_not_found":
      throw new HttpError(404, "user_not_found", `user ${ctx.username} not found`);
    case "peer_not_found":
      throw new HttpError(502, "upstream_failure", "account profile could not be resolved", {
        upstream_error: err.message,
      });
    case "no_discussion_group":
      throw new HttpError(502, "upstream_failure", "unexpected library error", {
        upstream_error: err.message,
      });
    case "message_not_found":
      throw new HttpError(404, "comment_not_found", `comment ${ctx.commentId} was deleted`);
    case "forbidden":
      throw new HttpError(502, "upstream_failure", "telegram refused the reply", {
        upstream_error: err.message,
      });
    case "flood_wait":
      throw new HttpError(
        500,
        "flood_wait",
        `telegram asks to wait ${String(err.retryAfter)} seconds`,
        {
          reason: err.message,
          retry_after: err.retryAfter,
        },
      );
    case "session_invalid":
      throw new HttpError(
        500,
        "session_invalid",
        `telegram session for ${ctx.username} is not valid`,
        {
          reason: err.message,
        },
      );
    case "upstream":
      throw new HttpError(502, "upstream_failure", "tg api timeout", {
        upstream_error: err.message,
      });
  }
}

/** Sync context: what goes into sync_error and whether the job is disabled. */
export function translateSyncError(e: unknown): { error: string; disable: boolean } {
  if (!isTelegramError(e)) throw e;
  const error = `${e.kind}: ${e.message}`;
  switch (e.kind) {
    case "user_not_found":
    case "session_invalid":
      return { error, disable: true };
    case "peer_not_found":
    case "no_discussion_group":
    case "message_not_found":
    case "forbidden":
    case "flood_wait":
    case "upstream":
      return { error, disable: false };
  }
}

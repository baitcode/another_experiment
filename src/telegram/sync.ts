import type { Infra } from "../deps.ts";
import type { PickedJob } from "../sync/models/jobs.ts";
import type { PlatformSyncRunner, RunOptions, RunWrite } from "../sync/runner.ts";
import { translateSyncError } from "./api/errors.ts";
import type { Page } from "./client/types.ts";
import { insertFromMessages } from "./models/comments.ts";
import { getPost, markSyncFailure, markSyncSuccess, threadCoordinates } from "./models/posts.ts";

/**
 * One run: fetch one page above the post's high-water mark and hand back the write for it. The
 * sync domain commits that write in the run's fenced transaction. Resolves nothing; thread
 * coordinates come from the post row.
 */
export const telegramSyncRunner: PlatformSyncRunner = async (
  infra: Infra,
  job: PickedJob,
  options: RunOptions,
): Promise<RunWrite> => {
  const post = await getPost(infra.db, job.postId);
  if (post === null) {
    return () => Promise.resolve({ status: "failure", error: "post not found", disable: true });
  }

  let page: Page;
  try {
    const coords = threadCoordinates(post);
    const client = await infra.telegram(post.username);
    page = await client.getThreadMessages(
      coords.chatId,
      coords.rootMessageId,
      post.lastSyncedMessageId ?? 0,
      options.pageSize,
    );
  } catch (e: unknown) {
    const { error, disable } = translateSyncError(e);
    return async (tx) => {
      await markSyncFailure(tx, post.id, error, infra.now());
      return { status: "failure", error, disable };
    };
  }

  return async (tx) => {
    await insertFromMessages(tx, post.id, page.messages);
    const maxId = page.messages.reduce<number | null>(
      (acc, m) => (acc === null || m.id > acc ? m.id : acc),
      null,
    );
    await markSyncSuccess(tx, post.id, { lastSyncedMessageId: maxId, at: infra.now() });
    return { status: "success" };
  };
};

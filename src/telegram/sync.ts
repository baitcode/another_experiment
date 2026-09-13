import type { Deps } from "../deps.ts";
import type { PickedJob } from "../sync/models/jobs.ts";
import type { Lease, PlatformSyncRunner, RunOutcome } from "../sync/runner.ts";
import { translateSyncError } from "./api/errors.ts";
import type { Page } from "./client/types.ts";
import { insertFromMessages } from "./models/comments.ts";
import { getPost, markSyncFailure, markSyncSuccess, threadCoordinates } from "./models/posts.ts";

/**
 * One run: fetch one page above the post's high-water mark and write it in the lease's fenced
 * transaction. Resolves nothing; thread coordinates come from the post row.
 */
export function createTelegramSyncRunner(
  deps: Deps,
  options: { pageSize: number },
): PlatformSyncRunner {
  return {
    platform: "telegram",
    async run(job: PickedJob, lease: Lease): Promise<RunOutcome> {
      const post = await getPost(deps.db, job.postId);
      if (post === null) {
        return lease.commit(() =>
          Promise.resolve({ status: "failure", error: "post not found", disable: true })
        );
      }

      let page: Page;
      try {
        const coords = threadCoordinates(post);
        const client = await deps.telegram(post.username);
        page = await client.getThreadMessages(
          coords.chatId,
          coords.rootMessageId,
          post.lastSyncedMessageId ?? 0,
          options.pageSize,
        );
      } catch (e: unknown) {
        const { error, disable } = translateSyncError(e);
        return lease.commit(async (tx) => {
          await markSyncFailure(tx, post.id, error, deps.now());
          return { status: "failure", error, disable };
        });
      }

      return lease.commit(async (tx) => {
        await insertFromMessages(tx, post.id, page.messages);
        const maxId = page.messages.reduce<number | null>(
          (acc, m) => (acc === null || m.id > acc ? m.id : acc),
          null,
        );
        await markSyncSuccess(tx, post.id, { lastSyncedMessageId: maxId, at: deps.now() });
        return { status: "success" };
      });
    },
  };
}

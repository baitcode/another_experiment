import { type Context, Hono } from "@hono/hono";
import { z } from "zod";
import { HttpError } from "../../api/errors.ts";
import { type PageQuery, pageQuerySchema, toPageQuery } from "../../api/pagination.ts";
import type { Deps } from "../../deps.ts";
import {
  listCommentReplies,
  listComments,
  replyBodySchema,
  replyToComment,
} from "./handlers/comments.ts";
import { deletePost, getPostView, submitBodySchema, submitPost } from "./handlers/posts.ts";

const uuid = z.uuid();

function pathId(c: Context, name: string, code: string, noun: string): string {
  const raw = c.req.param(name) ?? "";
  if (!uuid.safeParse(raw).success) {
    throw new HttpError(404, code, `${noun} ${raw} not found`);
  }
  return raw;
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "malformed_body", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.map(String).join(".")}`;
    throw new HttpError(400, "malformed_body", `${issue?.message ?? "invalid body"}${where}`);
  }
  return parsed.data;
}

function parsePage(c: Context): PageQuery {
  const parsed = pageQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, "malformed_query", issue?.message ?? "invalid query");
  }
  return toPageQuery(parsed.data);
}

export function createTelegramApi(deps: Deps): Hono {
  const app = new Hono();

  app.post("/posts", async (c) => {
    const body = await parseBody(c, submitBodySchema);
    const result = await submitPost(deps, body);
    return result.status === 201 ? c.json(result, 201) : c.json(result, 200);
  });

  app.get("/posts/:postId", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    return c.json(await getPostView(deps, postId), 200);
  });

  app.delete("/posts/:postId", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    return c.json(await deletePost(deps, postId), 200);
  });

  app.get("/posts/:postId/comments", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    const page = parsePage(c);
    const result = await listComments(deps, { postId, page });
    return c.json({ status: 200, ...result }, 200);
  });

  app.post("/posts/:postId/comments/:commentId/reply", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    const commentId = pathId(c, "commentId", "comment_not_found", "comment");
    const body = await parseBody(c, replyBodySchema);
    const view = await replyToComment(deps, { postId, commentId, text: body.text });
    return c.json({ status: 201, ...view }, 201);
  });

  app.get("/posts/:postId/comments/:commentId/replies", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    const commentId = pathId(c, "commentId", "comment_not_found", "comment");
    const page = parsePage(c);
    const result = await listCommentReplies(deps, { postId, commentId, page });
    return c.json({ status: 200, ...result }, 200);
  });

  return app;
}

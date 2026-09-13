import type { Context } from "@hono/hono";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  body(): Record<string, unknown> {
    return { status: this.status, code: this.code, message: this.message, ...this.extra };
  }

  toResponse(): Response {
    return Response.json(this.body(), { status: this.status });
  }
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof HttpError) return err.toResponse();
  console.error(`${c.req.method} ${c.req.path}:`, err);
  return new HttpError(500, "internal_error", "internal error").toResponse();
}

export function notFoundHandler(c: Context): Response {
  return new HttpError(404, "not_found", `no route for ${c.req.method} ${c.req.path}`)
    .toResponse();
}

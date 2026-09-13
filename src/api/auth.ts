import type { MiddlewareHandler } from "@hono/hono";
import { sign, verify } from "@hono/hono/jwt";
import { HttpError } from "./errors.ts";

const ALG = "HS256";

export function bearerJwt(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || token === undefined || token === "") {
      throw new HttpError(401, "unauthorized", "missing bearer token");
    }
    try {
      await verify(token, secret, ALG);
    } catch {
      throw new HttpError(401, "unauthorized", "invalid bearer token");
    }
    await next();
  };
}

/** Issues a service token; used by tests and by the README's curl example. */
export function signToken(secret: string, subject: string, ttlSeconds = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: subject, iat: now, exp: now + ttlSeconds }, secret, ALG);
}

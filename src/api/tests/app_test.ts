import { assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import { createApp } from "../app.ts";
import { signToken } from "../auth.ts";
import { HttpError } from "../errors.ts";

const secret = "test-secret";

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function app(): Hono {
  const sub = new Hono();
  sub.get("/ok", (c) => c.json({ status: 200 }));
  sub.get("/boom", () => {
    throw new HttpError(404, "post_not_found", "post x not found", { extra: 1 });
  });
  sub.get("/crash", () => {
    throw new Error("unexpected");
  });
  return createApp({ jwtSecret: secret, mounts: [{ path: "/telegram/v1", app: sub }] });
}

Deno.test("health needs no token", async () => {
  const res = await app().request("/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: 200, ok: true });
});

Deno.test("mounted routes require a valid bearer token", async () => {
  const a = app();
  const missing = await a.request("/telegram/v1/ok");
  assertEquals(missing.status, 401);
  assertEquals((await jsonBody(missing)).code, "unauthorized");
  const bad = await a.request("/telegram/v1/ok", { headers: { Authorization: "Bearer nope" } });
  assertEquals(bad.status, 401);
  const token = await signToken(secret, "service");
  const ok = await a.request("/telegram/v1/ok", { headers: { Authorization: `Bearer ${token}` } });
  assertEquals(ok.status, 200);
});

Deno.test("HttpError is serialised with status, code, message and extras", async () => {
  const token = await signToken(secret, "service");
  const res = await app().request("/telegram/v1/boom", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), {
    status: 404,
    code: "post_not_found",
    message: "post x not found",
    extra: 1,
  });
});

Deno.test("unexpected errors are 500 internal_error", async () => {
  const token = await signToken(secret, "service");
  const res = await app().request("/telegram/v1/crash", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assertEquals(res.status, 500);
  assertEquals((await jsonBody(res)).code, "internal_error");
});

Deno.test("unknown routes are 404 not_found", async () => {
  const token = await signToken(secret, "service");
  const res = await app().request("/nope", { headers: { Authorization: `Bearer ${token}` } });
  assertEquals(res.status, 404);
  assertEquals((await jsonBody(res)).code, "not_found");
});

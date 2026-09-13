import { Hono } from "@hono/hono";
import { bearerJwt } from "./auth.ts";
import { errorHandler, notFoundHandler } from "./errors.ts";

export interface Mount {
  path: string;
  app: Hono;
}

export interface AppOptions {
  jwtSecret: string;
  mounts: Mount[];
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.get("/health", (c) => c.json({ status: 200, ok: true }));
  const auth = bearerJwt(options.jwtSecret);
  for (const mount of options.mounts) {
    app.use(`${mount.path}/*`, auth);
    app.route(mount.path, mount.app);
  }
  return app;
}

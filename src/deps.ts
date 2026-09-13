import type { Db } from "./db/client.ts";
import type { TelegramFactory } from "./telegram/client/client.ts";

export interface Deps {
  db: Db;
  telegram: TelegramFactory;
  now: () => Date;
}

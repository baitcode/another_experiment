import type { Db } from "./db/client.ts";
import { TelegramClientProvider } from "./telegram/client/client.ts";

export interface Infra {
  db: Db;
  telegram: TelegramClientProvider;
  now: () => Date;
}

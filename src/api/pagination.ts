import { z } from "zod";
import { decodeCursor, encodeCursor } from "./cursor.ts";

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export interface PageQuery {
  limit: number;
  after: string | null;
}

export interface PageResult<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export function toPageQuery(raw: z.infer<typeof pageQuerySchema>): PageQuery {
  return { limit: raw.limit, after: raw.cursor === undefined ? null : decodeCursor(raw.cursor) };
}

/** `rows` were fetched with `limit + 1`; the extra row only says whether there is a next page. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): PageResult<T> {
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    has_more,
    next_cursor: has_more && last !== undefined ? encodeCursor(last.id) : null,
  };
}

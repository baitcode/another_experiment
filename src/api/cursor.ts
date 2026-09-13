import { z } from "zod";
import { HttpError } from "./errors.ts";

const cursorSchema = z.object({ after: z.string().min(1) });

export function encodeCursor(afterId: string): string {
  return btoa(JSON.stringify({ after: afterId }));
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    return cursorSchema.parse(parsed).after;
  } catch {
    throw new HttpError(400, "malformed_cursor", "cursor is not a valid page cursor");
  }
}

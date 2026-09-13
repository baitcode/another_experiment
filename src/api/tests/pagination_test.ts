import { assertEquals } from "@std/assert";
import { pageQuerySchema, toPage } from "../pagination.ts";

Deno.test("pageQuerySchema defaults and bounds", () => {
  const parsed = pageQuerySchema.parse({});
  assertEquals(parsed.limit, 20);
  assertEquals(parsed.cursor, undefined);
  assertEquals(pageQuerySchema.parse({ limit: "5" }).limit, 5);
  assertEquals(pageQuerySchema.safeParse({ limit: "0" }).success, false);
  assertEquals(pageQuerySchema.safeParse({ limit: "101" }).success, false);
});

Deno.test("toPage cuts the extra row and points the cursor at the last item", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const page = toPage(rows, 2);
  assertEquals(page.items.map((r) => r.id), ["a", "b"]);
  assertEquals(page.has_more, true);
  assertEquals(page.next_cursor, btoa(JSON.stringify({ after: "b" })));
  const last = toPage([{ id: "c" }], 2);
  assertEquals(last.has_more, false);
  assertEquals(last.next_cursor, null);
});

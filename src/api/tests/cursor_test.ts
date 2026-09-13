import { assertEquals, assertThrows } from "@std/assert";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import { HttpError } from "../errors.ts";

Deno.test("cursor round-trips an id", () => {
  const id = "01a08dcf-9995-704a-ac33-2c6e6233dcb8";
  const cursor = encodeCursor(id);
  assertEquals(JSON.parse(atob(cursor)), { after: id });
  assertEquals(decodeCursor(cursor), id);
});

Deno.test("malformed cursors are 400 malformed_cursor", () => {
  const err = assertThrows(() => decodeCursor("not-base64!"), HttpError);
  assertEquals(err.status, 400);
  assertEquals(err.code, "malformed_cursor");
  assertThrows(() => decodeCursor(btoa(JSON.stringify({ after: 5 }))), HttpError);
});

import { assertEquals, assertThrows } from "@std/assert";
import { HttpError } from "../../api/errors.ts";
import { parsePostUrl } from "../api/handlers/posts.ts";

Deno.test("supported url forms", () => {
  assertEquals(parsePostUrl("https://t.me/durov/123"), {
    ref: "durov",
    messageId: 123,
    topicId: null,
  });
  assertEquals(parsePostUrl("t.me/durov/123"), { ref: "durov", messageId: 123, topicId: null });
  assertEquals(parsePostUrl("https://t.me/durov/123?single"), {
    ref: "durov",
    messageId: 123,
    topicId: null,
  });
  assertEquals(parsePostUrl("https://t.me/c/1234567/89"), {
    ref: 1234567,
    messageId: 89,
    topicId: null,
  });
  assertEquals(parsePostUrl("https://t.me/c/-1001234567/89"), {
    ref: 1234567,
    messageId: 89,
    topicId: null,
  });
  assertEquals(parsePostUrl("https://t.me/myforum/42/42"), {
    ref: "myforum",
    messageId: 42,
    topicId: 42,
  });
  assertEquals(parsePostUrl("https://t.me/c/555/7/7"), { ref: 555, messageId: 7, topicId: 7 });
  assertEquals(parsePostUrl("tg://resolve?domain=durov&post=123"), {
    ref: "durov",
    messageId: 123,
    topicId: null,
  });
  assertEquals(parsePostUrl("tg://privatepost?channel=1234567&post=89"), {
    ref: 1234567,
    messageId: 89,
    topicId: null,
  });
  assertEquals(parsePostUrl("tg://privatepost?channel=-1001234567&post=89"), {
    ref: 1234567,
    messageId: 89,
    topicId: null,
  });
});

function malformed(url: string, message: string): void {
  const err = assertThrows(() => parsePostUrl(url), HttpError);
  assertEquals(err.status, 400);
  assertEquals(err.code, "malformed_url");
  assertEquals(err.message, message);
}

Deno.test("unsupported forms are 400 malformed_url", () => {
  malformed("https://example.com/durov/123", "url does not match any supported form");
  malformed("https://t.me/durov", "url does not match any supported form");
  malformed("https://t.me/durov/abc", "url does not match any supported form");
  malformed("not a url", "url does not match any supported form");
  malformed("tg://resolve?domain=durov", "url does not match any supported form");
  malformed("https://t.me/durov/123?comment=5", "links to a specific comment are not supported");
  malformed(
    "tg://resolve?domain=durov&post=123&comment=5",
    "links to a specific comment are not supported",
  );
  malformed("https://t.me/myforum/42/43", "forum link must point at the topic root");
  malformed("https://t.me/c/555/7/8", "forum link must point at the topic root");
});

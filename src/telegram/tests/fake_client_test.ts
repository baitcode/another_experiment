import { assertEquals, assertRejects } from "@std/assert";
import { FakeTelegram } from "../client/fake.ts";
import { MessageNotFound, UserNotFound } from "../client/errors.ts";

function world(): FakeTelegram {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.addPeer(200, { chatId: 200, kind: "supergroup" });
  fake.linkDiscussion(100, 5, { chatId: 200, rootMessageId: 50 });
  fake.addThread(200, 50);
  return fake;
}

Deno.test("forUser rejects unknown accounts", async () => {
  const fake = world();
  await assertRejects(() => fake.forUser("bob"), UserNotFound);
});

Deno.test("resolvePeer by username and by id", async () => {
  const c = await world().forUser("alice");
  assertEquals(await c.resolvePeer("mychannel"), { chatId: 100, kind: "channel" });
  assertEquals(await c.resolvePeer(200), { chatId: 200, kind: "supergroup" });
});

Deno.test("thread messages page ascending above minId", async () => {
  const fake = world();
  fake.addMessage(200, 50, { id: 51, replyToMessageId: 50, text: "a" });
  fake.addMessage(200, 50, { id: 52, replyToMessageId: 51, text: "b" });
  fake.addMessage(200, 50, { id: 53, replyToMessageId: 50, text: "c" });
  const c = await fake.forUser("alice");
  const page = await c.getThreadMessages(200, 50, 51, 100);
  assertEquals(page.messages.map((m) => m.id), [52, 53]);
  const limited = await c.getThreadMessages(200, 50, 0, 2);
  assertEquals(limited.messages.map((m) => m.id), [51, 52]);
});

Deno.test("getMessages reports missing ids as deleted", async () => {
  const fake = world();
  fake.addMessage(200, 50, { id: 51, replyToMessageId: 50, text: "a" });
  const c = await fake.forUser("alice");
  const got = await c.getMessages(200, [51, 99]);
  assertEquals(got.map((m) => m.kind), ["message", "deleted"]);
});

Deno.test("sendReply appends the account's message to the thread", async () => {
  const fake = world();
  fake.addMessage(200, 50, { id: 51, replyToMessageId: 50, text: "a" });
  const c = await fake.forUser("alice");
  const sent = await c.sendReply(200, 51, "hi", null);
  const [m] = await c.getMessages(200, [sent.messageId]);
  assertEquals(m?.kind, "message");
  if (m?.kind === "message") {
    assertEquals(m.author, { id: 1, username: "alice", name: "Alice" });
    assertEquals(m.replyToMessageId, 51);
  }
  await assertRejects(() => c.sendReply(200, 999, "x", null), MessageNotFound);
});

Deno.test("failNext makes the next call throw", async () => {
  const fake = world();
  const c = await fake.forUser("alice");
  fake.failNext(new MessageNotFound(200, 50));
  await assertRejects(() => c.getThreadMessages(200, 50, 0, 10), MessageNotFound);
  assertEquals((await c.getThreadMessages(200, 50, 0, 10)).messages, []);
});

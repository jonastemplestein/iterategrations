import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { ApiError, SeesawChallengeError, SeesawClient, type Fetch } from "../dist/index.js";
import { saveSession } from "../src/session-file.js";

const session = { accessToken: "test-token", personId: "parent-1" };
const ok = (response: unknown): Response => Response.json({ status: "OK", response });
function fake(handler: (request: Request) => Response | Promise<Response>): {
  fetch: Fetch;
  sent: Request[];
} {
  const sent: Request[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      sent.push(request);
      return handler(request);
    },
  };
}

test("login uses form encoding and stores the returned token, never the password", async () => {
  const backend = fake(async (request) => {
    assert.equal(request.url, "https://app.seesaw.me/api/auth/login");
    assert.equal(request.headers.has("authorization"), false);
    assert.match(request.headers.get("content-type")!, /x-www-form-urlencoded/);
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get("email"), "parent+one@example.invalid");
    assert.equal(form.get("password"), "p&a=ss+ word");
    assert.equal(form.get("role"), "parent");
    assert.equal(form.get("classes"), "true");
    return ok({ user_token: "test-token", person: { person_id: "parent-1" } });
  });
  const client = new SeesawClient({ fetch: backend.fetch });
  assert.deepEqual(await client.login("parent+one@example.invalid", "p&a=ss+ word"), session);
  assert.deepEqual(client.getSession(), session);
});

test("MFA and captcha stop login without automatic retries or token replacement", async () => {
  for (const challenge of ["two-factor", "captcha"] as const) {
    const backend = fake(() =>
      ok(
        challenge === "captcha"
          ? { recaptcha_required: true }
          : { two_factor_authentication_required: true, two_factor_authentication_method: "email" },
      ),
    );
    const client = new SeesawClient({ fetch: backend.fetch, session });
    await assert.rejects(
      client.login("parent@example.invalid", "password"),
      (error: unknown) => error instanceof SeesawChallengeError && error.challenge === challenge,
    );
    assert.equal(backend.sent.length, 1);
    assert.deepEqual(client.getSession(), session);
  }
});

test("journal pagination follows opaque cursors and stops at the end", async () => {
  const backend = fake((request) => {
    const url = new URL(request.url);
    assert.equal(request.headers.get("authorization"), "Bearer test-token");
    assert.equal(url.pathname, "/api/person/parent/feed");
    assert.equal(url.searchParams.get("limit"), "8");
    return url.searchParams.has("start_key")
      ? (assert.equal(url.searchParams.get("start_key"), "a+b/=?"),
        ok({ items: { objects: [{ item: { item_id: "2" }, type: "item" }], last_key: null } }))
      : ok({ items: { objects: [{ item: { item_id: "1" }, type: "item" }], last_key: "a+b/=?" } });
  });
  const client = new SeesawClient({ fetch: backend.fetch, session });
  const items = [];
  for await (const entry of client.journal()) items.push(entry.item);
  assert.deepEqual(items, [{ item_id: "1" }, { item_id: "2" }]);
  assert.equal(backend.sent.length, 2);
});

test("repeated cursors fail instead of looping", async () => {
  const backend = fake(() => ok({ items: { objects: [], last_key: "loop" } }));
  const client = new SeesawClient({ fetch: backend.fetch, session });
  await assert.rejects(async () => {
    for await (const _ of client.journal()) {
      /* exhaust */
    }
  }, /repeated-page-cursor/);
  assert.equal(backend.sent.length, 2);
});

test("messages use the separate GraphQL origin and retain pagination", async () => {
  const connection = {
    edges: [{ message: { id: "m1", content: "Fixture" } }],
    pageInfo: { endCursor: "cursor-2", hasNextPage: true },
  };
  const backend = fake(async (request) => {
    assert.equal(request.url, "https://reloaded-api.seesaw.me/ss2_gql");
    const body = await request.json();
    assert.deepEqual(body.variables, { conversationId: "conv-1", cursor: "cursor-1", limit: 12 });
    return Response.json({
      data: {
        conversation: {
          __typename: "ConversationPayload",
          conversation: { messagesConnection: connection },
        },
      },
    });
  });
  assert.deepEqual(
    await new SeesawClient({ fetch: backend.fetch, session }).getMessages("conv-1", {
      cursor: "cursor-1",
      limit: 12,
    }),
    connection,
  );
});

test("HTTP, REST and GraphQL errors do not become successful empty results", async () => {
  const denied = fake(() => new Response("password secret", { status: 403 }));
  await assert.rejects(
    new SeesawClient({ fetch: denied.fetch, session }).getParent(),
    (e: unknown) =>
      e instanceof ApiError && e.status === 403 && !e.message.includes("password secret"),
  );
  const rest = fake(() =>
    Response.json({ status: "ERROR", error_dict: { error_code: 900, error_message: "secret" } }),
  );
  await assert.rejects(
    new SeesawClient({ fetch: rest.fetch }).login("a@b.invalid", "secret"),
    /900/,
  );
  for (const body of [
    { errors: [{ message: "secret" }] },
    { data: { conversation: { __typename: "InvalidAuth", errorCode: "AuthError" } } },
  ]) {
    const backend = fake(() => Response.json(body));
    await assert.rejects(
      new SeesawClient({ fetch: backend.fetch, session }).getMessages("conv-1"),
      ApiError,
    );
  }
});

test("reads do not clear notifications; sends run once on a network failure", async () => {
  const backend = fake((r) => {
    assert.equal(new URL(r.url).searchParams.get("clear_unread_count"), "false");
    return ok({ sections: [] });
  });
  await new SeesawClient({ fetch: backend.fetch, session }).getNotifications();
  let calls = 0;
  const client = new SeesawClient({
    session,
    allowWrites: true,
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      assert.equal(JSON.parse(init?.body as string).variables.tempId, "stable-id");
      throw new Error("Connection lost after write");
    },
  });
  await assert.rejects(client.sendMessage("conv-1", "Hello", "stable-id"), /Connection lost/);
  assert.equal(calls, 1);
});

test("session files are private and replacement remains private", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seesaw-test-"));
  try {
    const path = join(dir, "session.json");
    await saveSession(path, session);
    await saveSession(path, { ...session, accessToken: "rotated" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, "utf8")).accessToken, "rotated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shipped CLI runs help without login or network", () => {
  assert.match(
    execFileSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "help"], {
      encoding: "utf8",
    }),
    /Seesaw parent API/,
  );
});

test("default client blocks comments, likes and message mutations", async () => {
  let calls = 0;
  const client = new SeesawClient({
    session,
    fetch: async () => {
      calls++;
      throw new Error("Must not request");
    },
  });
  for (const operation of [
    () => client.sendMessage("id", "Hello"),
    () => client.addComment("id", "Hello"),
    () => client.setLike("id", true),
    () => client.graphql("mutation { anything }"),
  ])
    await assert.rejects(async () => operation(), /writes are disabled/);
  assert.equal(calls, 0);
});

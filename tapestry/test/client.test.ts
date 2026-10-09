import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vite-plus/test";
import { ApiError, TapestryClient, type Fetch, type TapestrySession } from "../dist/index.js";

const school = { id: 123, furlSlug: "fixture-school", name: "Fixture nursery" };
const session: TapestrySession = {
  deviceId: "test-device",
  userAccessToken: "account-token",
  selectedSchool: {
    school,
    credentials: { access: "school-token", refresh: "refresh-token" },
    expiresAt: 10_000_000,
  },
};
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

test("account login and school selection use different tokens with one device ID", async () => {
  const backend = fake(async (r) => {
    assert.equal(new URL(r.url).origin, "https://www.tapestryjournal.com");
    assert.equal(r.headers.get("x-device-id"), "test-device");
    switch (new URL(r.url).pathname) {
      case "/api/4/authenticate":
        assert.equal(r.headers.has("x-api-key"), false);
        assert.deepEqual(await r.json(), {
          email: "parent@example.invalid",
          password: "test-password",
        });
        return Response.json({ credentials: { access: "account-token" } });
      case "/api/4/school-list":
        assert.equal(r.headers.get("x-api-key"), "account-token");
        return Response.json({ schools: [school] });
      case "/api/4/authenticate-school":
        assert.equal(r.headers.get("x-api-key"), "account-token");
        assert.deepEqual(await r.json(), { id: 123, appVersion: "1.0.7" });
        return Response.json({
          school,
          credentials: { access: "school-token", refresh: "refresh-token", expiry: 3600 },
        });
      case "/api/4/children/list":
        assert.equal(r.headers.get("x-api-key"), "school-token");
        return Response.json([{ id: 9 }]);
      default:
        throw new Error("Unexpected request");
    }
  });
  const client = new TapestryClient({
    fetch: backend.fetch,
    session: { deviceId: "test-device" },
    now: () => 1000,
  });
  assert.deepEqual(await client.login("parent@example.invalid", "test-password"), [school]);
  await assert.rejects(client.getChildren(), /authenticate a school/);
  await client.authenticateSchool(123);
  assert.deepEqual(await client.getChildren(), [{ id: 9 }]);
  assert.equal(client.getSession().selectedSchool?.expiresAt, 3_601_000);
  assert.equal(JSON.stringify(client.getSession()).includes("test-password"), false);
});

test("concurrent reads share a refresh and use the rotated credentials", async () => {
  let refreshCalls = 0;
  const backend = fake(async (r) => {
    if (new URL(r.url).pathname.endsWith("refresh-authenticate-school")) {
      refreshCalls++;
      assert.deepEqual(await r.json(), { refresh: "refresh-token" });
      assert.equal(r.headers.get("x-api-key"), "school-token");
      return Response.json({
        school: { id: school.id },
        credentials: { access: "rotated", refresh: "rotated-refresh", expiry: 3600 },
      });
    }
    assert.equal(r.headers.get("x-api-key"), "rotated");
    return Response.json({});
  });
  const client = new TapestryClient({ session, fetch: backend.fetch, now: () => 10_000_000 });
  await Promise.all([client.getChildren(), client.getCurrentUser(), client.getUpdateCounts()]);
  assert.equal(refreshCalls, 1);
  assert.equal(client.getSession().selectedSchool?.credentials.refresh, "rotated-refresh");
  assert.equal(client.getSession().selectedSchool?.school.furlSlug, "fixture-school");
});

test("failed refresh stops the read and never loops", async () => {
  const backend = fake(() =>
    Response.json(
      { type: "problems/api/authentication/username-password-login-required" },
      { status: 401 },
    ),
  );
  const client = new TapestryClient({ session, fetch: backend.fetch, now: () => 10_000_000 });
  await assert.rejects(
    client.getChildren(),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
  assert.equal(backend.sent.length, 1);
});

test("MFA errors retain the account session and do not retry", async () => {
  const backend = fake(() =>
    Response.json({ type: "app/problems/multi-factor-authentication-required" }, { status: 403 }),
  );
  const client = new TapestryClient({
    session: { deviceId: "test-device", userAccessToken: "account-token" },
    fetch: backend.fetch,
  });
  await assert.rejects(
    client.authenticateSchool(123),
    (e: unknown) =>
      e instanceof ApiError && e.code === "app/problems/multi-factor-authentication-required",
  );
  assert.equal(client.getSession().userAccessToken, "account-token");
  assert.equal(backend.sent.length, 1);
});

test("tokens never follow redirects or caller-supplied origins", async () => {
  const backend = fake(() => Response.json({}));
  const client = new TapestryClient({ session, fetch: backend.fetch, now: () => 0 });
  for (const path of [
    "https://other.invalid",
    "//other.invalid",
    "../authenticate",
    "children/%2e%2e",
    "children\\..",
    "children/list?redirect=x",
  ])
    await assert.rejects(client.request(path), /Expected an API/);
  assert.equal(backend.sent.length, 0);
  await client.getObservation(9);
  assert.equal(backend.sent[0].url, "https://www.tapestryjournal.com/api/4/observations/get/9");
  assert.equal(backend.sent[0].redirect, "error");
});

test("wrong-school refresh cannot replace the selected school", async () => {
  const backend = fake(() =>
    Response.json({ school: { ...school, id: 456 }, credentials: { access: "wrong" } }),
  );
  const client = new TapestryClient({ session, fetch: backend.fetch, now: () => 10_000_000 });
  await assert.rejects(client.getChildren(), /school-mismatch/);
  assert.equal(client.getSession().selectedSchool?.credentials.access, "school-token");
});

test("web views keep auth headers and reject login redirects", async () => {
  const backend = fake((r) => {
    assert.equal(new URL(r.url).pathname, "/s/fixture-school/v3/care-diary/relative");
    assert.equal(r.headers.get("x-api-key"), "school-token");
    assert.equal(r.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "/login" } });
  });
  await assert.rejects(
    new TapestryClient({ session, fetch: backend.fetch, now: () => 0 }).getWebView("care-diary"),
    ApiError,
  );
});

test("writes are explicit, accept 204 and are not retried", async () => {
  const backend = fake(async (r) => {
    assert.equal(new URL(r.url).pathname, "/api/4/notifications/mark-seen");
    assert.deepEqual(await r.json(), { notificationId: 15 });
    return new Response(null, { status: 204 });
  });
  assert.equal(
    await new TapestryClient({
      session,
      fetch: backend.fetch,
      now: () => 0,
      allowWrites: true,
    }).markNotificationSeen(15),
    null,
  );
  assert.equal(backend.sent.length, 1);
});

test("exported sessions are copies", () => {
  const client = new TapestryClient({ session });
  const exported = client.getSession();
  exported.selectedSchool!.credentials.access = "changed";
  assert.equal(client.getSession().selectedSchool!.credentials.access, "school-token");
});

test("shipped CLI help runs without login or network", () => {
  assert.match(
    execFileSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "help"], {
      encoding: "utf8",
    }),
    /Tapestry Education Platform API/,
  );
});

test("school website bootstrap keeps cookies and CSRF for POST reads", async () => {
  const config = { csrfToken: "csrf-one", authenticatedUser: { id: 42 } };
  const html = `<div class="hidden" data-modern-javascript-function-id="tapestry3">${JSON.stringify(config).replaceAll('"', "&quot;")}</div>`;
  const backend = fake(async (r) => {
    assert.match(r.headers.get("user-agent")!, /TapestryAppWebView\/1\.0\.7/);
    const path = new URL(r.url).pathname;
    if (path.endsWith("/v3/observations"))
      return new Response(html, {
        headers: {
          "content-type": "text/html",
          "set-cookie": "tapestry_session=fixture-cookie; Path=/; HttpOnly",
        },
      });
    assert.equal(r.headers.get("cookie"), "tapestry_session=fixture-cookie");
    assert.equal(
      r.headers.get("x-csrf-token"),
      path.endsWith("messages") ? "csrf-two" : "csrf-one",
    );
    assert.equal(r.headers.get("x-tapestry-version"), "3");
    assert.equal(r.headers.get("x-api-key"), "school-token");
    if (path.endsWith("/conversations")) {
      assert.deepEqual(await r.json(), { userId: 42 });
      return Response.json([{ conversation_id: 9 }], { headers: { "x-csrf-token": "csrf-two" } });
    }
    assert.deepEqual(await r.json(), { userId: 42, conversationId: 9, cursor: "opaque +/=" });
    return Response.json({ data: [], next_cursor: null, prev_cursor: null });
  });
  const client = new TapestryClient({ session, fetch: backend.fetch, now: () => 0 });
  assert.deepEqual(await client.getConversations(), [{ conversation_id: 9 }]);
  await client.getMessages(9, "opaque +/=");
  assert.equal(backend.sent.length, 3);
});

test("default clients reject all explicit writes before a network request", async () => {
  const backend = fake(() => {
    throw new Error("Must not make a request");
  });
  const client = new TapestryClient({ session, fetch: backend.fetch, now: () => 0 });
  for (const operation of [
    () => client.sendMessage(9, "Hello"),
    () => client.addComment(9, "Hello"),
    () => client.markNotificationSeen(9),
    () => client.createConversation(9),
    () => client.createObservation({}),
    () => client.setLike(9, true),
  ]) {
    await assert.rejects(async () => operation(), /writes are disabled/);
  }
  assert.equal(backend.sent.length, 0);
});

test("observation pagination encodes cursors and rejects repeats", async () => {
  const backend = fake((r) => {
    const query = new URL(r.url).searchParams;
    assert.equal(query.get("perPage"), "2");
    assert.equal(query.get("children.child_id"), "7");
    if (!query.has("cursor"))
      return Response.json({ observations: [{ id: 1 }], nextCursor: "opaque +/=" });
    assert.equal(query.get("cursor"), "opaque +/=");
    return Response.json({ observations: [{ id: 2 }], nextCursor: "opaque +/=" });
  });
  const iterator = new TapestryClient({ session, fetch: backend.fetch, now: () => 0 }).observations(
    { limit: 2, childId: 7 },
  );
  assert.equal((await iterator.next()).value?.id, 1);
  assert.equal((await iterator.next()).value?.id, 2);
  await assert.rejects(iterator.next(), /repeated-page-cursor/);
});

test("school request rejects traversal and CSRF failures do not retry writes", async () => {
  const backend = fake((r) =>
    new URL(r.url).pathname.endsWith("/v3/observations")
      ? new Response(
          '<div data-modern-javascript-function-id="tapestry3">{&quot;csrfToken&quot;:&quot;first&quot;,&quot;authenticatedUser&quot;:{&quot;id&quot;:42}}</div>',
        )
      : Response.json({ success: 0, code: "CSRF", newToken: "second" }),
  );
  const client = new TapestryClient({
    session,
    fetch: backend.fetch,
    now: () => 0,
    allowWrites: true,
  });
  await assert.rejects(client.schoolRequest("../other-school"), /relative path/);
  await assert.rejects(
    client.sendMessage(9, "hello"),
    (e: unknown) => e instanceof ApiError && e.code === "CSRF",
  );
  assert.equal(backend.sent.length, 2);
});

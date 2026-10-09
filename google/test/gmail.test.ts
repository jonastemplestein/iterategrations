// Runs against dist, the package as shipped. `fakeGmail` puts a pretend Gmail behind the global
// `fetch`, which is the project's egress in a loaded worker: it answers the profile, the last
// day's messages, the history from each start it knows (any other start is a 404, as Gmail answers
// a history id it no longer keeps), each message and attachment, and the watch, and it records
// every request. `fakeProject` is the project's `itx`: a kv, files, and appends that refuse a key
// used twice for another event (as the platform does; the same event again is a no-op).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "vite-plus/test";
import { pullGmail, receiveGmailPush, watchGmail } from "../dist/google.js";

const SECRET = "/secrets/own-google-1a2b3c4d";
const AUTHORIZATION = 'Bearer getSecret("/secrets/own-google-1a2b3c4d", { field: "accessToken" })';
const STREAM = "/integrations/gmail-ada";
const TOPIC = "projects/acme-example/topics/gmail-push";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PUSH_URL = "https://gmail-push--acme.example/push";
const TOKEN = "a-made-up-push-token";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const base64url = (text: string | Uint8Array) => Buffer.from(text).toString("base64url");

type HistoryPage = {
  history?: { messagesAdded: { message: { id: string; labelIds?: string[] } }[] }[];
  historyId: string;
  nextPageToken?: string;
};
type Sent = { method: string; url: string; authorization: string | null; body: unknown };

function fakeGmail() {
  const requests: Sent[] = [];
  const gmail = {
    requests,
    /** The account's history id now, as the profile answers it. */
    historyId: "900",
    /** The last day's message ids, newest first, as `messages.list` answers them. */
    recent: [] as string[],
    /** A page of history by its start (`<startHistoryId>`, or `<startHistoryId>#<pageToken>`). */
    history: {} as Record<string, HistoryPage>,
    /** Each message, as `format=full` answers it. */
    messages: {} as Record<string, unknown>,
    /** Each attachment's bytes, by attachment id. */
    attachments: {} as Record<string, Uint8Array>,
    watch: { status: 200, expiration: String(Date.parse("2026-10-16T08:00:00.000Z")) },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: text ? JSON.parse(text) : undefined,
    });
    const url = new URL(request.url);
    assert.ok(request.url.startsWith(API), request.url);
    const route = url.pathname.slice(new URL(API).pathname.length);
    const query = url.searchParams;
    const notFound = Response.json(
      { error: { code: 404, message: "Requested entity was not found." } },
      { status: 404 },
    );
    if (route === "/profile")
      return Response.json({ emailAddress: "ada@example.com", historyId: gmail.historyId });
    if (route === "/messages") {
      assert.equal(query.get("q"), "newer_than:1d");
      return Response.json({ messages: gmail.recent.map((id) => ({ id, threadId: `t-${id}` })) });
    }
    if (route === "/history") {
      assert.equal(query.get("historyTypes"), "messageAdded");
      const start = query.get("startHistoryId")!;
      const page =
        gmail.history[query.get("pageToken") ? `${start}#${query.get("pageToken")}` : start];
      return page ? Response.json(page) : notFound;
    }
    if (route === "/watch")
      return gmail.watch.status === 200
        ? Response.json({ historyId: "4000", expiration: gmail.watch.expiration })
        : Response.json({ error: { message: "the topic refuses Gmail" } }, { status: 403 });
    const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(route);
    if (attachment) {
      const bytes = gmail.attachments[attachment[2]!];
      return bytes ? Response.json({ size: bytes.byteLength, data: base64url(bytes) }) : notFound;
    }
    const message = /^\/messages\/([^/]+)$/.exec(route);
    if (message) {
      assert.equal(query.get("format"), "full");
      const found = gmail.messages[message[1]!];
      return found ? Response.json(found) : notFound;
    }
    return new Response("unexpected\n", { status: 500 });
  }) as typeof fetch;
  return gmail;
}

function fakeProject() {
  const kv: Record<string, string> = {};
  const files: Record<string, { contentType: string; data: Uint8Array }> = {};
  const appended: { path: string; event: any }[] = [];
  const itx = {
    kv: {
      get: async (key: string) => kv[key] ?? null,
      put: async (key: string, value: string) => void (kv[key] = value),
      delete: async (key: string) => void delete kv[key],
      list: async (prefix = "") => ({
        keys: Object.keys(kv).filter((key) => key.startsWith(prefix)),
      }),
    },
    files: {
      get: (path: string) => ({
        put: async ({ contentType, data }: { contentType: string; data: Uint8Array }) => {
          files[path] = { contentType, data };
          return { path, contentType, size: data.byteLength };
        },
      }),
    },
    cd: (path: string) => ({
      append: async (event: any) => {
        const earlier = appended.find(
          (a) =>
            a.path === path &&
            event.idempotencyKey !== undefined &&
            a.event.idempotencyKey === event.idempotencyKey,
        );
        if (earlier && JSON.stringify(earlier.event) === JSON.stringify(event)) return;
        if (earlier) throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
  };
  /** The cursor a sync keeps in the kv. */
  const cursor = () => JSON.parse(kv[`gmail-sync:${STREAM}`] ?? "null");
  /** The ids of the messages added on the stream, in order. */
  const added = () =>
    appended.filter((a) => a.event.type === "gmail/message-added").map((a) => a.event.payload.id);
  return { itx, kv, files, appended, cursor, added };
}

/** A message as Gmail's `format=full` answers it: one plain text part. */
const mail = (id: string, labelIds = ["INBOX"]) => ({
  id,
  threadId: `t-${id}`,
  labelIds,
  snippet: `snippet of ${id}`,
  internalDate: String(Date.parse("2026-10-09T07:30:00.000Z")),
  payload: { mimeType: "text/plain", headers: [], body: { data: base64url(`body of ${id}`) } },
});
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `m${String(from + i).padStart(2, "0")}`);
const added = (...list: string[]) => list.map((id) => ({ message: { id, labelIds: ["INBOX"] } }));

// ------------------------------------------------------------ the push receiver

/** Pub/Sub's push: the notification as base64 JSON in `message.data` (standard or base64url). */
const push = (
  token: string | null,
  data: unknown,
  message: { messageId?: string; publishTime?: string } = {
    messageId: "2070443601311540",
    publishTime: "2026-10-09T08:00:00.000Z",
  },
  encode: (text: string) => string = (text) => Buffer.from(text).toString("base64"),
) =>
  new Request(token === null ? PUSH_URL : `${PUSH_URL}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { data: encode(JSON.stringify(data)), ...message },
      subscription: "projects/acme-example/subscriptions/gmail-push",
    }),
  });
const ADA = { emailAddress: "ada@example.com", historyId: "12345" };

test("the push receiver takes only a POST whose token hashes to tokenSha256: anything else is refused and appends nothing", async () => {
  const project = fakeProject();
  const options = { tokenSha256: TOKEN_SHA256, streamOf: () => STREAM };
  const get = new Request(`${PUSH_URL}?token=${TOKEN}`);
  assert.equal((await receiveGmailPush(get, project.itx, options)).status, 405);
  for (const token of ["wrong", "", null])
    assert.equal((await receiveGmailPush(push(token, ADA), project.itx, options)).status, 401);
  // with no hash kept, no token is good
  const unset = { ...options, tokenSha256: null };
  assert.equal((await receiveGmailPush(push(TOKEN, ADA), project.itx, unset)).status, 401);
  assert.deepEqual(project.appended, []);
});

test("a push that is no Gmail notification, or names an address streamOf does not know, is acknowledged and appends nothing", async () => {
  const project = fakeProject();
  const asked: string[] = [];
  const options = {
    tokenSha256: TOKEN_SHA256,
    streamOf: (address: string) => (asked.push(address), null),
  };
  const raw = (body: string) => new Request(`${PUSH_URL}?token=${TOKEN}`, { method: "POST", body });
  for (const request of [
    raw("not JSON"),
    raw("{}"),
    raw(JSON.stringify({ message: { data: "!!!", messageId: "1" } })),
    push(TOKEN, { emailAddress: "ada@example.com" }), // no history id
    push(TOKEN, ADA, { publishTime: "2026-10-09T08:00:00.000Z" }), // no Pub/Sub message id
    push(TOKEN, { emailAddress: "Grace@Example.com", historyId: "1" }),
  ])
    assert.equal((await receiveGmailPush(request, project.itx, options)).status, 204);
  assert.deepEqual(asked, ["grace@example.com"]);
  assert.deepEqual(project.appended, []);
});

test("a notification lands once on the stream of the address it names, however often Pub/Sub delivers it, in either base64 alphabet", async () => {
  const project = fakeProject();
  const asked: string[] = [];
  const options = {
    tokenSha256: TOKEN_SHA256,
    streamOf: (address: string) => (
      asked.push(address),
      address === "ada@example.com" ? STREAM : null
    ),
  };
  const delivery = () => push(TOKEN, { emailAddress: "Ada@Example.com", historyId: 12345 });
  assert.equal((await receiveGmailPush(delivery(), project.itx, options)).status, 204);
  assert.equal((await receiveGmailPush(delivery(), project.itx, options)).status, 204);
  // the same Pub/Sub message again with other contents conflicts, and is acknowledged all the same
  const other = push(TOKEN, { emailAddress: "Ada@Example.com", historyId: 12399 });
  assert.equal((await receiveGmailPush(other, project.itx, options)).status, 204);
  assert.deepEqual(project.appended, [
    {
      path: STREAM,
      event: {
        type: "gmail/push-received",
        idempotencyKey: "gmail-push:2070443601311540",
        payload: {
          emailAddress: "Ada@Example.com",
          historyId: "12345",
          messageId: "2070443601311540",
          publishTime: "2026-10-09T08:00:00.000Z",
        },
      },
    },
  ]);
  assert.deepEqual(asked, ["ada@example.com", "ada@example.com", "ada@example.com"]);

  // Google documents the data as base64url: a `~` in an address encodes as `-` there, `+` in base64
  const tilde = { emailAddress: "ada~home@example.com", historyId: "555" };
  const either = {
    tokenSha256: TOKEN_SHA256,
    streamOf: (address: string) => (address === "ada~home@example.com" ? STREAM : null),
  };
  for (const [messageId, encode] of [
    ["2070443601311541", base64url],
    ["2070443601311542", (text: string) => Buffer.from(text).toString("base64")],
  ] as const) {
    const request = push(TOKEN, tilde, { messageId }, encode);
    assert.equal((await receiveGmailPush(request, project.itx, either)).status, 204);
  }
  assert.deepEqual(
    project.appended
      .slice(1)
      .map((a) => [a.event.payload.emailAddress, a.event.payload.publishTime]),
    [
      ["ada~home@example.com", null],
      ["ada~home@example.com", null],
    ],
  );
});

// --------------------------------------------------------------------- the watch

test("watchGmail asks Gmail, as the account, to publish the INBOX and SENT changes to the topic, and records the watch on the stream", async () => {
  const gmail = fakeGmail();
  const project = fakeProject();
  const watch = await watchGmail(project.itx, { secret: SECRET, path: STREAM, topicName: TOPIC });
  assert.deepEqual(watch, {
    topicName: TOPIC,
    historyId: "4000",
    expiresAt: "2026-10-16T08:00:00.000Z",
  });
  assert.deepEqual(gmail.requests, [
    {
      method: "POST",
      url: `${API}/watch`,
      authorization: AUTHORIZATION,
      body: { topicName: TOPIC, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "include" },
    },
  ]);
  assert.deepEqual(project.appended, [
    { path: STREAM, event: { type: "gmail/watch-registered", payload: watch } },
  ]);
  // a watch Gmail refuses throws, and records nothing
  gmail.watch.status = 403;
  await assert.rejects(
    watchGmail(project.itx, { secret: SECRET, path: STREAM, topicName: TOPIC }),
    /gmail watch answered 403: .*the topic refuses Gmail/,
  );
  assert.equal(project.appended.length, 1);
});

// ---------------------------------------------------------------------- the sync

test("a page of history becomes the ids still to fetch, drafts and ids already waiting skipped, and at most 25 messages land a run, oldest first", async () => {
  const gmail = fakeGmail();
  const project = fakeProject();
  project.kv[`gmail-sync:${STREAM}`] = JSON.stringify({ historyId: "500", pending: ["m00"] });
  gmail.history["500"] = {
    history: [
      { messagesAdded: added(...ids(1, 20)) },
      {
        messagesAdded: [
          { message: { id: "d1", labelIds: ["DRAFT"] } },
          { message: { id: "m00", labelIds: ["INBOX"] } },
        ],
      },
    ],
    historyId: "520", // the mailbox's history id now, on every page
    nextPageToken: "page-2",
  };
  gmail.history["500#page-2"] = {
    history: [{ messagesAdded: added(...ids(21, 29)) }],
    historyId: "520",
  };
  for (const id of ids(0, 29)) gmail.messages[id] = mail(id);
  delete gmail.messages["m05"]; // deleted since it arrived: nothing to add

  assert.deepEqual(await pullGmail(project.itx, { secret: SECRET, path: STREAM }), {
    added: 25,
    waiting: 4,
    historyId: "520",
  });
  assert.deepEqual(project.added(), [...ids(0, 4), ...ids(6, 25)]);
  assert.deepEqual(project.cursor(), { historyId: "520", pending: ids(26, 29) });
  assert.ok(gmail.requests.every((request) => request.authorization === AUTHORIZATION));
  assert.deepEqual(
    gmail.requests.filter((request) => request.url.includes("/history?")).map((r) => r.url),
    [
      `${API}/history?startHistoryId=500&historyTypes=messageAdded&maxResults=500`,
      `${API}/history?startHistoryId=500&historyTypes=messageAdded&maxResults=500&pageToken=page-2`,
    ],
  );

  // the next run takes the rest
  gmail.history["520"] = { historyId: "520" };
  assert.deepEqual(await pullGmail(project.itx, { secret: SECRET, path: STREAM }), {
    added: 4,
    waiting: 0,
    historyId: "520",
  });
  assert.deepEqual(project.added().slice(-4), ids(26, 29));
});

test("a history id Gmail no longer keeps (404) starts again from the last day's mail and keeps the ids still to fetch; so does a first sync", async () => {
  const gmail = fakeGmail();
  const project = fakeProject();
  project.kv[`gmail-sync:${STREAM}`] = JSON.stringify({ historyId: "7", pending: ["old"] });
  gmail.recent = ["new2", "new1", "old"]; // newest first
  gmail.history["900"] = { historyId: "900" };
  for (const id of ["old", "new1", "new2"]) gmail.messages[id] = mail(id);
  assert.deepEqual(await pullGmail(project.itx, { secret: SECRET, path: STREAM }), {
    added: 3,
    waiting: 0,
    historyId: "900",
  });
  assert.deepEqual(project.added(), ["old", "new1", "new2"]);
  assert.ok(
    gmail.requests.some((r) => r.url === `${API}/messages?q=newer_than%3A1d&maxResults=500`),
  );

  // a first sync has no cursor: it starts from the profile's history id and the last day's mail
  const first = fakeProject();
  assert.deepEqual(await pullGmail(first.itx, { secret: SECRET, path: STREAM }), {
    added: 3,
    waiting: 0,
    historyId: "900",
  });
  assert.deepEqual(first.added(), ["old", "new1", "new2"]);
});

test("a message lands once as gmail/message-added, field for field, its attachments and a long body as project files beside it", async () => {
  const gmail = fakeGmail();
  const project = fakeProject();
  const html = `<p>${"long ".repeat(60_000)}</p>`; // over 256 KiB
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  gmail.attachments["att-1"] = pdf;
  gmail.attachments["att-2"] = new Uint8Array([1, 2, 3]);
  gmail.messages["m1"] = {
    id: "m1",
    threadId: "t-m1",
    labelIds: ["INBOX", "CATEGORY_PERSONAL"],
    snippet: "Grüße, Ada",
    internalDate: String(Date.parse("2026-10-09T07:30:00.000Z")),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Grace <grace@example.com>" },
        { name: "To", value: "ada@example.com" },
        { name: "CC", value: "team@example.com" },
        { name: "Subject", value: "The plan" },
        { name: "Date", value: "Fri, 9 Oct 2026 08:30:00 +0100" },
        { name: "Message-ID", value: "<made-up-1@example.com>" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }],
              body: { data: base64url(Buffer.from("Grüße, Ada", "latin1")) },
            },
            { mimeType: "text/html", body: { data: base64url(html) } },
          ],
        },
        { mimeType: "application/pdf", filename: "plan.pdf", body: { attachmentId: "att-1" } },
        { mimeType: "application/pdf", filename: "plan.pdf", body: { attachmentId: "att-2" } },
        { mimeType: "", filename: "a/b.txt", body: { data: base64url("inline") } },
        { mimeType: "image/png", filename: "empty.png", body: { size: 0 } },
      ],
    },
  };
  project.kv[`gmail-sync:${STREAM}`] = JSON.stringify({ historyId: "500", pending: [] });
  gmail.history["500"] = { history: [{ messagesAdded: added("m1") }], historyId: "501" };
  await pullGmail(project.itx, { secret: SECRET, path: STREAM });

  assert.deepEqual(project.appended, [
    {
      path: STREAM,
      event: {
        type: "gmail/message-added",
        idempotencyKey: "gmail:m1",
        payload: {
          id: "m1",
          threadId: "t-m1",
          receivedAt: "2026-10-09T07:30:00.000Z",
          labelIds: ["INBOX", "CATEGORY_PERSONAL"],
          from: "Grace <grace@example.com>",
          to: "ada@example.com",
          cc: "team@example.com",
          subject: "The plan",
          date: "Fri, 9 Oct 2026 08:30:00 +0100",
          messageId: "<made-up-1@example.com>",
          snippet: "Grüße, Ada",
          text: "Grüße, Ada",
          html: { path: `${STREAM}/m1/body.html`, chars: html.length },
          attachments: [
            {
              filename: "plan.pdf",
              contentType: "application/pdf",
              size: 5,
              path: `${STREAM}/m1/plan.pdf`,
            },
            {
              filename: "plan.pdf",
              contentType: "application/pdf",
              size: 3,
              path: `${STREAM}/m1/plan (2).pdf`,
            },
            {
              filename: "a/b.txt",
              contentType: "application/octet-stream",
              size: 6,
              path: `${STREAM}/m1/a_b.txt`,
            },
          ],
        },
      },
    },
  ]);
  assert.deepEqual(Object.keys(project.files).sort(), [
    `${STREAM}/m1/a_b.txt`,
    `${STREAM}/m1/body.html`,
    `${STREAM}/m1/plan (2).pdf`,
    `${STREAM}/m1/plan.pdf`,
  ]);
  assert.deepEqual(project.files[`${STREAM}/m1/plan.pdf`], {
    contentType: "application/pdf",
    data: pdf,
  });
  assert.equal(project.files[`${STREAM}/m1/body.html`]!.contentType, "text/html; charset=utf-8");
  assert.equal(new TextDecoder().decode(project.files[`${STREAM}/m1/body.html`]!.data), html);

  // seen again (Gmail's history names it under other labels later): nothing new lands
  project.kv[`gmail-sync:${STREAM}`] = JSON.stringify({ historyId: "501", pending: ["m1"] });
  gmail.history["501"] = { historyId: "502" };
  await pullGmail(project.itx, { secret: SECRET, path: STREAM });
  assert.equal(project.appended.length, 1);
});

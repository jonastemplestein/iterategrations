// Runs against dist (the package as shipped): `pnpm test` builds first. `fakeFastmail` puts a
// pretend Fastmail behind the global `fetch`, which is the project's egress in a loaded worker. Like
// egress, it refuses a request toward an origin the secret is not pinned to. It answers the session,
// the upload URL and each JMAP method by name, and records every request.
import assert from "node:assert/strict";
import { afterEach, test } from "vite-plus/test";
import { fastmailCopies, fastmailVerdict, mailbox } from "../dist/index.js";

const SECRET = "/secrets/fastmail";
const AUTHORIZATION = `Bearer getSecret("${SECRET}", { field: "token" })`;
const SESSION_URL = "https://api.fastmail.com/jmap/session";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const MASKED = "https://www.fastmail.com/dev/maskedemail";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Email = Record<string, any>;
type Sent = { url: string; method: string; headers: Record<string, string>; body: any };

/** Fastmail behind the global `fetch`, and egress in front of it: a request with the placeholder
 *  toward an origin outside `pinned` gets egress's 502. The session names a regional host, as
 *  Fastmail's does. Answers come from `emails`, three mailboxes and two identities. */
function fakeFastmail(options: { pinned?: string[]; emails?: Email[] } = {}) {
  const fake = {
    pinned: options.pinned ?? ["https://api.fastmail.com"],
    refuseSubmissions: false,
    sent: [] as Sent[],
  };
  const emails = new Map((options.emails ?? []).map((email) => [email.id, email]));
  const masked = new Map<string, Email>();
  let next = 0;
  const session = {
    apiUrl: "https://ams.api.fastmail.com/jmap/api/",
    uploadUrl: "https://ams.api.fastmail.com/jmap/upload/{accountId}/",
    downloadUrl: "https://ams.api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}",
    username: "agent@example.com",
    primaryAccounts: { [MAIL]: "u1", [SUBMISSION]: "u1", [MASKED]: "u1" },
    capabilities: {},
    state: "s1",
  };
  const folder = (id: string, role: string, totalEmails = 0) => {
    const name = role[0]!.toUpperCase() + role.slice(1);
    return { id, name, role, parentId: null, totalEmails, unreadEmails: 0, sortOrder: 1 };
  };
  const mailboxes = [
    folder("mb-inbox", "inbox", 2),
    folder("mb-drafts", "drafts"),
    folder("mb-sent", "sent"),
  ];
  const identities = [
    { id: "id-agent", name: "Agent", email: "agent@example.com", replyTo: null },
    { id: "id-any", name: "Anyone", email: "*@example.net", replyTo: null },
  ];
  // what a /get answers: the asked properties (and the id), null for a missing one, as JMAP does
  const pick = (object: Email, properties?: string[]) =>
    properties
      ? Object.fromEntries(["id", ...properties].map((key) => [key, object[key] ?? null]))
      : object;
  const patch = (email: Email, changes: Email) => {
    for (const [path, value] of Object.entries(changes)) {
      const [key, inner] = path.split("/") as [string, string];
      email[key] = { ...email[key] };
      if (value === null) delete email[key][inner];
      else email[key][inner] = value;
    }
  };
  // each answers its call's arguments; answers after the first are onSuccessUpdateEmail's Email/set
  const handlers: Record<string, (args: Email, created: Record<string, string>) => Email[]> = {
    "Mailbox/get": (args) => [
      { accountId: "u1", list: mailboxes.map((m) => pick(m, args.properties)) },
    ],
    "Identity/get": (args) => [
      { accountId: "u1", list: identities.map((i) => pick(i, args.properties)) },
    ],
    "Email/set": (args, created) => {
      const result: Email = { accountId: "u1", created: {} };
      for (const [key, email] of Object.entries<Email>(args.create ?? {})) {
        const id = `M${++next}`;
        created[key] = id;
        const receivedAt = "2026-10-09T12:00:00Z";
        emails.set(id, {
          ...email,
          id,
          threadId: `T${id}`,
          receivedAt,
          messageId: [`${id}@example.com`],
        });
        result.created[key] = { id, threadId: `T${id}` };
      }
      return [result];
    },
    "EmailSubmission/set": (args, created) => {
      const [[key, submission]] = Object.entries<Email>(args.create) as [[string, Email]];
      if (fake.refuseSubmissions || !identities.some(({ id }) => id === submission.identityId))
        return [{ accountId: "u1", notCreated: { [key]: { type: "forbiddenFrom" } } }];
      const emailId = submission.emailId.replace(
        /^#(.*)/,
        (_: string, ref: string) => created[ref],
      );
      created[key] = "S1";
      const update = args.onSuccessUpdateEmail?.[`#${key}`];
      if (update) patch(emails.get(emailId)!, update);
      const own = { accountId: "u1", created: { [key]: { id: "S1" } } };
      return update ? [own, { accountId: "u1", updated: { [emailId]: null } }] : [own];
    },
    "Email/query": ({ filter, limit }) => {
      const [, header] = filter.header ?? [];
      const ids = [...emails.values()]
        .filter((email) => !filter.text || JSON.stringify(email).includes(filter.text))
        .filter((email) => !filter.inMailbox || email.mailboxIds?.[filter.inMailbox])
        .filter((email) => !filter.after || email.receivedAt > filter.after)
        .filter((email) => !header || email.messageId?.includes(header.replace(/^<|>$/g, "")))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, limit)
        .map((email) => email.id);
      return [{ accountId: "u1", ids }];
    },
    // in the order the messages were stored, not the order asked: JMAP promises none
    "Email/get": (args) => {
      const list = [...emails.values()].filter((email) => args.ids.includes(email.id));
      return [{ accountId: "u1", list: list.map((email) => pick(email, args.properties)) }];
    },
    "Thread/get": (args) => {
      const emailIds = (id: string) =>
        [...emails.values()].filter((email) => email.threadId === id).map((email) => email.id);
      return [
        { accountId: "u1", list: args.ids.map((id: string) => ({ id, emailIds: emailIds(id) })) },
      ];
    },
    "MaskedEmail/get": (args) => [
      { accountId: "u1", list: [...masked.values()].map((m) => pick(m, args.properties)) },
    ],
    "MaskedEmail/set": (args) => {
      const result: Email = { accountId: "u1", created: {}, updated: {}, notUpdated: {} };
      for (const [key, input] of Object.entries<Email>(args.create ?? {})) {
        const id = `masked-${++next}`;
        const made = { id, email: `${input.emailPrefix ?? "quiet.otter"}${next}@example.com` };
        const server = { ...made, createdAt: "2026-10-09T12:00:00Z", lastMessageAt: null };
        masked.set(id, { ...input, ...server, createdBy: "agent", url: null });
        result.created[key] = server;
      }
      for (const [id, changes] of Object.entries<Email>(args.update ?? {}))
        if (!masked.has(id)) result.notUpdated[id] = { type: "notFound" };
        else {
          Object.assign(masked.get(id)!, changes);
          result.updated[id] = null;
        }
      return [result];
    },
  };
  const answer = (request: { methodCalls: [string, Email, string][]; createdIds?: Email }) => {
    const created: Record<string, string> = { ...request.createdIds };
    const methodResponses: [string, Email, string][] = [];
    for (const [name, args, callId] of request.methodCalls) {
      // a back-reference reads an earlier answer: its /ids, or every thread's emailIds
      const resolved = Object.fromEntries(
        Object.entries(args).map(([key, ref]) => {
          if (!key.startsWith("#")) return [key, ref];
          const earlier = methodResponses.find(([, , id]) => id === ref.resultOf)![1];
          const ids =
            ref.path === "/ids" ? earlier.ids : earlier.list.flatMap((t: Email) => t.emailIds);
          return [key.slice(1), ids];
        }),
      );
      const handler = handlers[name];
      if (!handler) methodResponses.push(["error", { type: "unknownMethod" }, callId]);
      else {
        const [own, ...implicit] = handler(resolved, created);
        methodResponses.push([name, own!, callId]);
        for (const args of implicit) methodResponses.push(["Email/set", args, callId]);
      }
    }
    return {
      methodResponses,
      sessionState: "s1",
      ...(request.createdIds && { createdIds: created }),
    };
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = request.headers.get("content-type") === "application/json";
    const body: any = json ? await request.json() : undefined;
    fake.sent.push({
      url: url.href,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    });
    if (
      request.headers.get("authorization")?.includes("getSecret(") &&
      !fake.pinned.includes(url.origin)
    )
      return new Response(
        `itx.fetch: the secret ${SECRET} is pinned to ${fake.pinned.join(", ")} — not sent to ${url.origin}\n`,
        { status: 502 },
      );
    if (url.href === SESSION_URL) return Response.json(session);
    if (url.pathname === "/jmap/upload/u1/") {
      const size = (await request.arrayBuffer()).byteLength;
      const type = request.headers.get("content-type");
      return Response.json({ accountId: "u1", blobId: `blob-${++next}`, type, size });
    }
    if (url.pathname === "/jmap/api/") return Response.json(answer(body));
    return new Response("Not found\n", { status: 404 });
  }) as typeof fetch;
  return Object.assign(fake, { emails, masked });
}

/** A message in the Inbox, as Fastmail stores it: text and HTML parts, and one attachment. */
const received = (id: string, at: string, extra: Email = {}): Email => ({
  id,
  threadId: "T-order",
  mailboxIds: { "mb-inbox": true },
  keywords: {},
  from: [{ name: "Someone", email: "someone@example.org" }],
  to: [{ name: null, email: "agent@example.com" }],
  subject: `The order (${id})`,
  receivedAt: at,
  sentAt: at,
  preview: "Here is the order",
  hasAttachment: true,
  messageId: [`${id}@example.org`],
  textBody: [{ partId: "1", blobId: "b1", size: 17, name: null, type: "text/plain" }],
  htmlBody: [{ partId: "2", blobId: "b2", size: 24, name: null, type: "text/html" }],
  bodyValues: { "1": { value: "Here is the order" }, "2": { value: "<p>Here is the order</p>" } },
  attachments: [
    { partId: "3", blobId: "b3", size: 5120, name: "order.pdf", type: "application/pdf" },
  ],
  ...extra,
});

test("send writes the draft, submits it with the identity that covers the sender, and files it in Sent", async () => {
  const fastmail = fakeFastmail();
  const result = await mailbox({ secret: SECRET }).send({
    from: { name: "Agent", email: "agent@example.com" },
    to: ["someone@example.org"],
    cc: [],
    subject: "Re: the order",
    text: "Thanks, all received.",
    inReplyTo: "<their-message@example.org>",
    attachments: [{ name: "note.txt", type: "text/plain", data: "hello" }],
  });
  assert.deepEqual(result, { emailId: "M2", submissionId: "S1", filedInSent: true });

  const upload = fastmail.sent.find((request) => request.url.includes("/upload/"))!;
  assert.equal(upload.url, "https://api.fastmail.com/jmap/upload/u1/");
  assert.equal(upload.headers["content-type"], "text/plain");
  const posted = fastmail.sent.filter((request) => request.method === "POST" && request.body);
  const { using, methodCalls, createdIds } = posted.at(-1)!.body;
  assert.deepEqual(using, ["urn:ietf:params:jmap:core", MAIL, SUBMISSION]);
  assert.deepEqual(createdIds, {});
  assert.deepEqual(methodCalls, [
    [
      "Email/set",
      {
        accountId: "u1",
        create: {
          draft: {
            mailboxIds: { "mb-drafts": true },
            keywords: { $draft: true, $seen: true },
            from: [{ name: "Agent", email: "agent@example.com" }],
            to: [{ email: "someone@example.org" }],
            subject: "Re: the order",
            inReplyTo: ["their-message@example.org"],
            bodyValues: { text: { value: "Thanks, all received." } },
            textBody: [{ partId: "text", type: "text/plain" }],
            attachments: [
              {
                blobId: "blob-1",
                size: 5,
                name: "note.txt",
                type: "text/plain",
                disposition: "attachment",
              },
            ],
          },
        },
      },
      "write",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: "u1",
        create: { send: { identityId: "id-agent", emailId: "#draft" } },
        onSuccessUpdateEmail: {
          "#send": {
            "mailboxIds/mb-drafts": null,
            "mailboxIds/mb-sent": true,
            "keywords/$draft": null,
          },
        },
      },
      "submit",
    ],
  ]);
  // the submission referenced the message the same request created, and the server filed it
  const stored = fastmail.emails.get("M2")!;
  assert.deepEqual(stored.mailboxIds, { "mb-sent": true });
  assert.deepEqual(stored.keywords, { $seen: true });
});

test("send: a wildcard identity covers its domain; no identity, no text, or a refused submission throws", async () => {
  const fastmail = fakeFastmail();
  const mail = mailbox({ secret: SECRET });
  const sent = await mail.send({
    from: "desk@example.net",
    to: ["a@example.org"],
    subject: "Hi",
    html: "<p>Hi</p>",
  });
  assert.equal(sent.filedInSent, true);
  const submit = fastmail.sent.at(-1)!.body.methodCalls[1][1];
  assert.equal(submit.create.send.identityId, "id-any");
  await assert.rejects(
    mail.send({ from: "other@example.org", to: ["a@example.org"], subject: "Hi", text: "Hi" }),
    {
      message:
        "send: no identity covers other@example.org; the account's: agent@example.com, *@example.net",
    },
  );
  await assert.rejects(mail.send({ from: "agent@example.com", to: [], subject: "Hi" }), {
    message: "send: a message needs text or html",
  });
  // the server refuses the submission: nothing is sent, and the draft stays in Drafts
  fastmail.refuseSubmissions = true;
  await assert.rejects(
    mail.send({ from: "agent@example.com", to: ["a@example.org"], subject: "Hi", text: "Hi" }),
    { message: "send: forbiddenFrom" },
  );
  assert.deepEqual([...fastmail.emails.values()].at(-1)!.mailboxIds, { "mb-drafts": true });
});

test("search finds by mailbox role and words in one request, newest first, with JMAP's nulls as empty values", async () => {
  const fastmail = fakeFastmail({
    emails: [
      received("older", "2026-10-07T09:00:00Z", { cc: null, inReplyTo: null, references: null }),
      received("newer", "2026-10-08T09:00:00Z", { subject: null }),
      received("elsewhere", "2026-10-08T10:00:00Z", { mailboxIds: { "mb-sent": true } }),
    ],
  });
  const found = await mailbox({ secret: SECRET }).search({
    mailbox: "inbox",
    text: "order",
    after: "2026-10-01",
    limit: 10,
  });
  assert.deepEqual(
    found.map((email) => email.id),
    ["newer", "older"],
  );
  assert.deepEqual(found[1], {
    id: "older",
    threadId: "T-order",
    mailboxIds: { "mb-inbox": true },
    keywords: {},
    from: [{ name: "Someone", email: "someone@example.org" }],
    to: [{ name: null, email: "agent@example.com" }],
    cc: [],
    subject: "The order (older)",
    receivedAt: "2026-10-07T09:00:00Z",
    sentAt: "2026-10-07T09:00:00Z",
    preview: "Here is the order",
    hasAttachment: true,
    messageId: ["older@example.org"],
    inReplyTo: [],
    references: [],
  });
  assert.equal(found[0]!.subject, "");
  const { methodCalls } = fastmail.sent.at(-1)!.body;
  assert.deepEqual(methodCalls[0], [
    "Email/query",
    {
      accountId: "u1",
      filter: { text: "order", after: "2026-10-01T00:00:00.000Z", inMailbox: "mb-inbox" },
      sort: [{ property: "receivedAt", isAscending: false }],
      limit: 10,
    },
    "query",
  ]);
  assert.deepEqual(methodCalls[1][1]["#ids"], {
    name: "Email/query",
    resultOf: "query",
    path: "/ids",
  });
});

test("getEmail gives the text, the HTML and the attachments; getThread gives a thread oldest first", async () => {
  const fastmail = fakeFastmail({
    emails: [received("second", "2026-10-08T09:00:00Z"), received("first", "2026-10-07T09:00:00Z")],
  });
  const mail = mailbox({ secret: SECRET });
  const full = await mail.getEmail("first", { bodies: true });
  assert.equal(full!.text, "Here is the order");
  assert.equal(full!.html, "<p>Here is the order</p>");
  assert.deepEqual(full!.attachments, [
    { name: "order.pdf", type: "application/pdf", size: 5120, blobId: "b3" },
  ]);
  assert.equal(full!.subject, "The order (first)");
  assert.equal("bodyValues" in full!, false);
  const get = fastmail.sent.at(-1)!.body.methodCalls[0][1];
  assert.equal(get.fetchTextBodyValues, true);
  assert.equal(get.fetchHTMLBodyValues, true);

  const bare = await mail.getEmail("first");
  assert.deepEqual([bare!.text, bare!.html, bare!.attachments], ["", null, []]);
  assert.equal(await mail.getEmail("missing"), null);

  const thread = await mail.getThread("T-order");
  assert.deepEqual(
    thread.map((email) => email.id),
    ["first", "second"],
  );
});

test("mailboxes, identities and the Masked Email calls, which use Fastmail's capability", async () => {
  const fastmail = fakeFastmail();
  const mail = mailbox({ secret: SECRET });
  assert.deepEqual(await mail.mailbox("sent"), {
    id: "mb-sent",
    name: "Sent",
    role: "sent",
    parentId: null,
    totalEmails: 0,
    unreadEmails: 0,
  });
  assert.equal(await mail.mailbox("archive"), undefined);
  assert.deepEqual(await mail.identities(), [
    { id: "id-agent", name: "Agent", email: "agent@example.com" },
    { id: "id-any", name: "Anyone", email: "*@example.net" },
  ]);

  const made = await mail.createMaskedEmail({
    forDomain: "https://shop.example",
    description: "one order",
    emailPrefix: "shop",
  });
  assert.equal(made.email, "shop1@example.com");
  assert.equal(made.state, "enabled");
  assert.equal(made.forDomain, "https://shop.example");
  const create = fastmail.sent.at(-1)!.body;
  assert.deepEqual(create.using, ["urn:ietf:params:jmap:core", MASKED]);
  assert.deepEqual(create.methodCalls[0][1].create, {
    new: {
      state: "enabled",
      forDomain: "https://shop.example",
      description: "one order",
      emailPrefix: "shop",
    },
  });

  await mail.setMaskedEmailState(made.id, "disabled");
  assert.deepEqual(await mail.listMaskedEmails(), [
    {
      id: made.id,
      email: "shop1@example.com",
      state: "disabled",
      forDomain: "https://shop.example",
      description: "one order",
      lastMessageAt: null,
      createdAt: "2026-10-09T12:00:00Z",
    },
  ]);
  await assert.rejects(mail.setMaskedEmailState("masked-nope", "deleted"), {
    message: "MaskedEmail/set: notFound",
  });
  await assert.rejects(
    mail.createMaskedEmail({ forDomain: "x", description: "y", emailPrefix: "No!" }),
    {
      message: "MaskedEmail/set: emailPrefix is at most 64 of a-z, 0-9 and _",
    },
  );
});

test("every request goes to the session URL's origin, with the token's placeholder", async () => {
  const fastmail = fakeFastmail({ emails: [received("first", "2026-10-07T09:00:00Z")] });
  const mail = mailbox({ secret: SECRET });
  await mail.search();
  await mail.send({
    from: "agent@example.com",
    to: ["a@example.org"],
    subject: "Hi",
    text: "Hi",
    attachments: [
      { name: "a.bin", type: "application/octet-stream", data: new Uint8Array([1, 2, 3]) },
    ],
  });
  // one session, read once; the regional host it names is never asked
  assert.equal(fastmail.sent.filter((request) => request.url === SESSION_URL).length, 1);
  assert.deepEqual(
    new Set(fastmail.sent.map((request) => new URL(request.url).origin)),
    new Set(["https://api.fastmail.com"]),
  );
  for (const request of fastmail.sent) assert.equal(request.headers.authorization, AUTHORIZATION);
});

test("a secret pinned elsewhere: the error quotes egress's refusal, and the next call reads the session again", async () => {
  const fastmail = fakeFastmail({ pinned: ["https://jmap.example.com"] });
  const mail = mailbox({ secret: SECRET });
  await assert.rejects(mail.mailboxes(), {
    message:
      "the JMAP session at https://api.fastmail.com/jmap/session answered HTTP 502: itx.fetch: the secret /secrets/fastmail is pinned to https://jmap.example.com — not sent to https://api.fastmail.com",
  });
  fastmail.pinned = ["https://api.fastmail.com"];
  assert.equal((await mail.mailboxes()).length, 3);
});

/** Fastmail's copy of a forwarded mail: Fastmail's ARC set on top (instance 2), the sender's own
 *  below it, then the message's headers. */
const arcHeaders = (results: string, seal = "messagingengine.com") => [
  {
    name: "ARC-Seal",
    value: ` i=2; a=rsa-sha256; cv=pass; d=${seal}; s=fm1; t=1791000000; b=c2Vh`,
  },
  {
    name: "ARC-Message-Signature",
    value: " i=2; a=rsa-sha256; c=relaxed/relaxed; d=messagingengine.com; s=fm1; b=bWVz",
  },
  {
    name: "ARC-Authentication-Results",
    value: ` i=2; mx.messagingengine.com; arc=pass (as.1.example.org=pass, ams.1.example.org=pass) smtp.remote-ip=192.0.2.10; ${results}`,
  },
  { name: "ARC-Seal", value: " i=1; a=rsa-sha256; cv=none; d=example.org; s=arc; b=b3du" },
  {
    name: "ARC-Authentication-Results",
    value:
      " i=1; mx.messagingengine.com; dkim=pass header.d=example.org; dmarc=pass header.from=example.org",
  },
  { name: "From", value: " Someone <someone@example.org>" },
  { name: "Subject", value: " The order" },
];
const forwarded = {
  messageId: "order-1@example.org",
  from: "someone@example.org",
  subject: "The order",
  text: "Here is the order",
};
const copy = (headers: { name: string; value: string }[], extra = {}) => ({
  from: "someone@example.org",
  subject: "The order",
  text: "Here is  the order\n",
  headers,
  ...extra,
});

test("fastmailVerdict believes only Fastmail's own ARC set on top, and its pass for the From domain", () => {
  const dkim =
    "dkim=pass (2048-bit rsa key sha256) header.d=example.org header.i=@example.org header.s=s1";
  assert.deepEqual(fastmailVerdict(forwarded, [copy(arcHeaders(`${dkim}; dmarc=none`))]), {
    verified: true,
    reason: "Fastmail's check passed for example.org",
  });
  const dmarc =
    "dkim=pass header.d=mailer.example.net; dmarc=pass (p=none,d=none) policy.policy-from=p header.from=example.org";
  assert.equal(fastmailVerdict(forwarded, [copy(arcHeaders(dmarc))]).verified, true);
  // the sender's own set below says pass; Fastmail's on top does not, and only Fastmail's counts
  assert.deepEqual(
    fastmailVerdict(forwarded, [
      copy(arcHeaders("dkim=fail header.d=example.org; dmarc=fail header.from=example.org")),
    ]),
    {
      verified: false,
      reason:
        "Fastmail's check did not pass for example.org (dmarc=fail for example.org, no dkim pass for it)",
    },
  );
  assert.deepEqual(fastmailVerdict(forwarded, [copy(arcHeaders(dkim, "example.net"))]), {
    verified: false,
    reason: "Fastmail's own check is not on top of it",
  });
  const lower = arcHeaders(dkim).slice(3); // the sender's set alone, as if Fastmail had added none
  assert.equal(
    fastmailVerdict(forwarded, [copy(lower)]).reason,
    "Fastmail's own check is not on top of it",
  );
  assert.equal(
    fastmailVerdict(forwarded, [copy(arcHeaders(dkim), { subject: "Another order" })]).reason,
    "it differs from the mailbox's copy",
  );
  assert.equal(
    fastmailVerdict({ ...forwarded, messageId: null }, []).reason,
    "it has no Message-ID to find",
  );
  assert.equal(fastmailVerdict(forwarded, []).reason, "it is not in the mailbox");
});

test("fastmailCopies reads the mailbox's copies of a message by its Message-ID, outside Sent", async () => {
  const headers = arcHeaders("dkim=pass header.d=example.org");
  const fastmail = fakeFastmail({
    emails: [
      received("copy", "2026-10-08T09:00:00Z", { messageId: ["order-1@example.org"], headers }),
      received("ours", "2026-10-08T09:01:00Z", {
        messageId: ["order-1@example.org"],
        mailboxIds: { "mb-sent": true },
        headers: [],
      }),
      received("other", "2026-10-08T09:02:00Z"),
    ],
  });
  const copies = await fastmailCopies({ secret: SECRET }, "<order-1@example.org>");
  assert.deepEqual(copies, [
    {
      from: "someone@example.org",
      subject: "The order (copy)",
      text: "Here is the order",
      headers,
    },
  ]);
  const query = fastmail.sent.at(-1)!.body.methodCalls[0][1];
  assert.deepEqual(query.filter, { header: ["Message-ID", "<order-1@example.org>"] });
});

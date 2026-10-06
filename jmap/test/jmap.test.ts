// Runs against dist (the package as shipped): `pnpm test` builds first. A fake JMAP server answers
// the session, the upload URL and each method by name, and records every request.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { connectJmap, JmapError, maskedEmails } from "../dist/index.js";

const SESSION_URL = "https://jmap.test/session";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const MASKED = "https://www.fastmail.com/dev/maskedemail";

type Email = Record<string, any>;

/** A JMAP server in memory: two identities (one a wildcard), Inbox/Drafts/Sent, and `emails`. */
function fakeJmap(
  options: {
    emails?: Email[];
    capabilities?: string[];
    apiProblem?: { status: number; type: string };
  } = {},
) {
  const seen: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const emails = new Map<string, Email>((options.emails ?? []).map((email) => [email.id, email]));
  const masked = new Map<string, Email>();
  const capabilities = options.capabilities ?? [MAIL, SUBMISSION, MASKED];
  let next = 0;
  const session = {
    apiUrl: "https://jmap.test/api/",
    uploadUrl: "https://jmap.test/upload/{accountId}/",
    downloadUrl: "https://jmap.test/download/{accountId}/{blobId}/{name}",
    username: "agent@example.com",
    primaryAccounts: Object.fromEntries(capabilities.map((capability) => [capability, "acc-1"])),
    capabilities: Object.fromEntries(capabilities.map((capability) => [capability, {}])),
  };
  const mailboxes = [
    {
      id: "mb-inbox",
      name: "Inbox",
      role: "inbox",
      parentId: null,
      totalEmails: 2,
      unreadEmails: 1,
    },
    {
      id: "mb-drafts",
      name: "Drafts",
      role: "drafts",
      parentId: null,
      totalEmails: 0,
      unreadEmails: 0,
    },
    { id: "mb-sent", name: "Sent", role: "sent", parentId: null, totalEmails: 0, unreadEmails: 0 },
  ];
  const identities = [
    { id: "id-agent", name: "Agent", email: "agent@example.com" },
    { id: "id-any", name: "Anyone", email: "*@example.org" },
  ];
  const patch = (target: Email, changes: Record<string, unknown>) => {
    for (const [path, value] of Object.entries(changes)) {
      const [key, inner] = path.split("/");
      if (inner === undefined) target[key!] = value;
      else {
        target[key!] = { ...target[key!] };
        if (value === null) delete target[key!][inner];
        else target[key!][inner] = value;
      }
    }
  };
  const handlers: Record<
    string,
    (args: any, responses: any[], created: Map<string, string>) => any[]
  > = {
    "Mailbox/get": () => [{ accountId: "acc-1", list: mailboxes }],
    "Identity/get": () => [{ accountId: "acc-1", list: identities }],
    "Email/set": (args, _responses, created) => {
      const result: any = { accountId: "acc-1", created: {}, updated: {} };
      for (const [key, email] of Object.entries<any>(args.create ?? {})) {
        const id = `M${++next}`;
        created.set(key, id);
        emails.set(id, {
          ...email,
          id,
          threadId: email.inReplyTo ? "T1" : `T${id}`,
          receivedAt: new Date(Date.UTC(2026, 9, 6, 12, next)).toISOString(),
          messageId: [`${id}@jmap.test`],
          preview: email.bodyValues?.text?.value?.slice(0, 40) ?? "",
        });
        result.created[key] = { id, threadId: emails.get(id)!.threadId, blobId: `blob-${id}` };
      }
      for (const [id, changes] of Object.entries<any>(args.update ?? {})) {
        patch(emails.get(id)!, changes);
        result.updated[id] = null;
      }
      return [result];
    },
    "EmailSubmission/set": (args, _responses, created) => {
      const [[key, submission]] = Object.entries<any>(args.create);
      const emailId = submission.emailId.startsWith("#")
        ? created.get(submission.emailId.slice(1))
        : submission.emailId;
      if (!identities.some((identity) => identity.id === submission.identityId))
        return [{ accountId: "acc-1", notCreated: { [key!]: { type: "forbiddenFrom" } } }];
      const update = args.onSuccessUpdateEmail?.[`#${key}`];
      if (update) patch(emails.get(emailId!)!, update);
      return [
        { accountId: "acc-1", created: { [key!]: { id: "S1" } } },
        ...(update ? [["Email/set", { accountId: "acc-1", updated: { [emailId!]: null } }]] : []),
      ];
    },
    "Email/query": (args) => {
      const { filter, limit } = args;
      const ids = [...emails.values()]
        .filter((email) => !filter.text || JSON.stringify(email).includes(filter.text))
        .filter(
          (email) => !filter.from || email.from?.some((a: any) => a.email.includes(filter.from)),
        )
        .filter((email) => !filter.inMailbox || email.mailboxIds?.[filter.inMailbox])
        .filter((email) => !filter.after || email.receivedAt > filter.after)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, limit)
        .map((email) => email.id);
      return [{ accountId: "acc-1", ids }];
    },
    "Email/get": (args) => [
      {
        accountId: "acc-1",
        list: args.ids.map((id: string) => emails.get(id)).filter(Boolean),
        notFound: [],
      },
    ],
    "Thread/get": (args) => [
      {
        accountId: "acc-1",
        list: args.ids.map((id: string) => ({
          id,
          emailIds: [...emails.values()].filter((email) => email.threadId === id).map((e) => e.id),
        })),
      },
    ],
    "MaskedEmail/get": () => [{ accountId: "acc-1", list: [...masked.values()] }],
    "MaskedEmail/set": (args) => {
      const result: any = { accountId: "acc-1", created: {}, updated: {}, notUpdated: {} };
      for (const [key, input] of Object.entries<any>(args.create ?? {})) {
        const id = `masked-${++next}`;
        const email = `${input.emailPrefix ?? "random"}.${next}@fastmail.test`;
        masked.set(id, {
          ...input,
          id,
          email,
          createdAt: "2026-10-06T12:00:00Z",
          createdBy: "test",
        });
        result.created[key] = { id, email };
      }
      for (const [id, changes] of Object.entries<any>(args.update ?? {})) {
        if (!masked.has(id)) result.notUpdated[id] = { type: "notFound" };
        else Object.assign(masked.get(id)!, changes);
      }
      return [result];
    },
  };
  const fetch = async (input: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body =
      typeof init.body === "string" && init.body.startsWith("{")
        ? JSON.parse(init.body)
        : init.body;
    seen.push({ url: input, method: init.method ?? "GET", headers, body });
    if (input === SESSION_URL) return Response.json(session);
    if (input.startsWith("https://jmap.test/upload/acc-1/"))
      return Response.json({
        accountId: "acc-1",
        blobId: `upload-${++next}`,
        type: headers["content-type"],
        size: 5,
      });
    if (input === session.apiUrl) {
      if (options.apiProblem)
        return Response.json(
          { type: options.apiProblem.type, detail: "nope" },
          { status: options.apiProblem.status },
        );
      const responses: any[] = [];
      const created = new Map<string, string>();
      for (const [name, args, callId] of body.methodCalls) {
        const resolved = { ...args };
        for (const [key, ref] of Object.entries<any>(args))
          if (key.startsWith("#")) {
            const prior = responses.find(([, , id]) => id === ref.resultOf)[1];
            resolved[key.slice(1)] =
              ref.path === "/ids" ? prior.ids : prior.list.flatMap((item: any) => item.emailIds);
            delete resolved[key];
          }
        const handler = handlers[name];
        if (!handler) {
          responses.push(["error", { type: "unknownMethod" }, callId]);
          continue;
        }
        for (const result of handler(resolved, responses, created))
          responses.push(
            Array.isArray(result) ? [result[0], result[1], callId] : [name, result, callId],
          );
      }
      return Response.json({ methodResponses: responses, sessionState: "s1" });
    }
    return new Response("no answer", { status: 404 });
  };
  return { fetch, seen, emails, masked };
}

const connect = (server: ReturnType<typeof fakeJmap>, token?: string) =>
  connectJmap({ sessionUrl: SESSION_URL, fetch: server.fetch, token });

test("by default every request carries the secret placeholder, never a token; a token outside iterate is sent as a bearer", async () => {
  const server = fakeJmap();
  const jmap = await connect(server);
  await jmap.mailboxes();
  for (const request of server.seen)
    assert.equal(
      request.headers.authorization,
      'Bearer getSecret("/secrets/fastmail", { field: "token" })',
    );
  const direct = fakeJmap();
  await connect(direct, "t-123");
  assert.equal(direct.seen[0]!.headers.authorization, "Bearer t-123");
});

test("the session names the account each capability acts on; a capability the token lacks is a clear error", async () => {
  const jmap = await connect(fakeJmap({ capabilities: [MAIL, SUBMISSION] }));
  assert.equal(jmap.accountFor(MAIL), "acc-1");
  assert.throws(
    () => jmap.accountFor(MASKED),
    (error: unknown) => {
      assert.ok(error instanceof JmapError);
      assert.equal(error.type, "capabilityNotSupported");
      return true;
    },
  );
});

test("mailboxes are found by role, and identities list what the account may send as", async () => {
  const jmap = await connect(fakeJmap());
  assert.equal((await jmap.mailbox("sent"))?.id, "mb-sent");
  assert.equal(await jmap.mailbox("archive"), undefined);
  assert.deepEqual(
    (await jmap.identities()).map((identity) => identity.email),
    ["agent@example.com", "*@example.org"],
  );
});

test("send writes a draft from the matching identity, submits it, and files it in Sent", async () => {
  const server = fakeJmap();
  const jmap = await connect(server);
  const result = await jmap.send({
    from: { name: "Agent", email: "Agent@Example.com" },
    to: ["person@example.net"],
    subject: "Hello",
    text: "Hello there",
    inReplyTo: "<abc@example.net>",
  });
  assert.deepEqual(result, { emailId: result.emailId, submissionId: "S1", filedInSent: true });
  const call = server.seen.at(-1)!.body;
  assert.deepEqual(call.using, ["urn:ietf:params:jmap:core", MAIL, SUBMISSION]);
  const [[, set], [, submission]] = call.methodCalls;
  assert.deepEqual(set.create.draft.inReplyTo, ["abc@example.net"]);
  assert.deepEqual(set.create.draft.keywords, { $draft: true, $seen: true });
  assert.equal(submission.create.send.identityId, "id-agent");
  const stored = server.emails.get(result.emailId)!;
  assert.deepEqual(stored.mailboxIds, { "mb-sent": true });
  assert.deepEqual(stored.keywords, { $seen: true });
});

test("send uploads attachments first, and a wildcard identity covers its domain", async () => {
  const server = fakeJmap();
  const jmap = await connect(server);
  await jmap.send({
    from: "anything@example.org",
    to: ["person@example.net"],
    subject: "Files",
    html: "<p>see attached</p>",
    attachments: [{ name: "note.txt", type: "text/plain", data: "hello" }],
  });
  const upload = server.seen.find((request) => request.url.includes("/upload/"))!;
  assert.equal(upload.headers["content-type"], "text/plain");
  const draft = server.seen.at(-1)!.body.methodCalls[0][1].create.draft;
  assert.equal(draft.attachments[0].blobId.startsWith("upload-"), true);
  assert.equal(draft.attachments[0].name, "note.txt");
  assert.deepEqual(draft.htmlBody, [{ partId: "html", type: "text/html" }]);
  assert.equal(server.seen.at(-1)!.body.methodCalls[1][1].create.send.identityId, "id-any");
});

test("send from an address no identity covers is refused before anything is written", async () => {
  const server = fakeJmap();
  const jmap = await connect(server);
  await assert.rejects(
    jmap.send({ from: "someone@else.test", to: ["a@b.test"], subject: "x", text: "y" }),
    /send: forbiddenFrom \(no identity covers someone@else.test; the account's: agent@example.com, \*@example.org\)/,
  );
  assert.equal(server.emails.size, 0);
});

const INBOX = (id: string, minute: number, extra: Email = {}) => ({
  id,
  threadId: "T1",
  mailboxIds: { "mb-inbox": true },
  keywords: {},
  from: [{ name: "Person", email: "person@example.net" }],
  to: [{ name: null, email: "agent@example.com" }],
  subject: `Message ${id}`,
  receivedAt: new Date(Date.UTC(2026, 9, 5, 9, minute)).toISOString(),
  sentAt: null,
  preview: `preview ${id}`,
  hasAttachment: false,
  messageId: [`${id}@example.net`],
  ...extra,
});

test("search filters by words, sender, mailbox role and time, newest first, at most `limit`", async () => {
  const server = fakeJmap({
    emails: [INBOX("A", 1), INBOX("B", 2), INBOX("C", 3, { mailboxIds: { "mb-sent": true } })],
  });
  const jmap = await connect(server);
  const found = await jmap.search({
    from: "person@",
    mailbox: "inbox",
    after: "2026-10-05T09:00:30Z",
    limit: 5,
  });
  assert.deepEqual(
    found.map((email) => email.id),
    ["B", "A"],
  );
  assert.equal(found[0]!.from[0]!.email, "person@example.net");
  assert.deepEqual(found[0]!.cc, []);
  const query = server.seen.at(-1)!.body.methodCalls[0][1];
  assert.equal(query.filter.inMailbox, "mb-inbox");
  assert.equal(query.limit, 5);
  assert.deepEqual(
    await jmap.search({ text: "Message C", limit: 1 }).then((list) => list.map((e) => e.id)),
    ["C"],
  );
});

test("a thread is its messages, oldest first", async () => {
  const jmap = await connect(fakeJmap({ emails: [INBOX("B", 2), INBOX("A", 1)] }));
  assert.deepEqual(
    (await jmap.getThread("T1")).map((email) => email.id),
    ["A", "B"],
  );
});

test("getEmail with bodies joins the text and HTML parts and lists the attachments; a missing one is null", async () => {
  const jmap = await connect(
    fakeJmap({
      emails: [
        INBOX("A", 1, {
          bodyValues: { "1": { value: "plain words" }, "2": { value: "<p>words</p>" } },
          textBody: [{ partId: "1", type: "text/plain" }],
          htmlBody: [{ partId: "2", type: "text/html" }],
          attachments: [
            { partId: "3", blobId: "b3", name: "photo.jpg", type: "image/jpeg", size: 1200 },
          ],
        }),
      ],
    }),
  );
  const email = await jmap.getEmail("A", { bodies: true });
  assert.equal(email?.text, "plain words");
  assert.equal(email?.html, "<p>words</p>");
  assert.deepEqual(email?.attachments, [
    { name: "photo.jpg", type: "image/jpeg", size: 1200, blobId: "b3" },
  ]);
  assert.equal(await jmap.getEmail("missing"), null);
});

test("a method error names the method and its JMAP error type; a refused request names the request", async () => {
  const jmap = await connect(fakeJmap());
  await assert.rejects(
    jmap.method([MAIL], "Email/frobnicate", {}),
    /^JmapError: Email\/frobnicate: unknownMethod$/,
  );
  const refused = await connect(
    fakeJmap({ apiProblem: { status: 403, type: "urn:ietf:params:jmap:error:limit" } }),
  );
  await assert.rejects(refused.mailboxes(), /request: urn:ietf:params:jmap:error:limit \(nope\)/);
});

test("masked email: create (enabled by default), list, and switch off or delete; a bad prefix is refused before the network", async () => {
  const server = fakeJmap();
  const masked = maskedEmails(await connect(server));
  const made = await masked.create({
    forDomain: "https://shop.example",
    description: "a one-off order",
    emailPrefix: "shop",
  });
  assert.equal(made.state, "enabled");
  assert.match(made.email, /^shop\.\d+@fastmail\.test$/);
  const create = server.seen.at(-1)!.body.methodCalls[0][1].create.new;
  assert.deepEqual(create, {
    state: "enabled",
    forDomain: "https://shop.example",
    description: "a one-off order",
    emailPrefix: "shop",
  });
  await masked.setState(made.id, "disabled");
  assert.equal((await masked.list()).find((entry) => entry.id === made.id)?.state, "disabled");
  await masked.setState(made.id, "deleted");
  await assert.rejects(masked.setState("nope", "enabled"), /MaskedEmail\/set: notFound/);
  const requests = server.seen.length;
  await assert.rejects(
    masked.create({ forDomain: "x", description: "y", emailPrefix: "Bad-Prefix" }),
    /emailPrefix/,
  );
  assert.equal(server.seen.length, requests);
  const plain = maskedEmails(await connect(fakeJmap({ capabilities: [MAIL, SUBMISSION] })));
  await assert.rejects(plain.list(), /capabilityNotSupported/);
});

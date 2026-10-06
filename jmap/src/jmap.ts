/**
 * A small JMAP client: RFC 8620 (the core: a session, method calls over HTTPS and JSON) and RFC 8621
 * (mail: mailboxes, identities, messages, threads, sending). Fastmail's by default; any JMAP server
 * by its session URL.
 *
 * It holds no credential. The `Authorization` header it sends is, by default, a placeholder naming a
 * secret, which iterate's egress swaps for the real token toward the secret's pinned origin. Every
 * request goes through the `fetch` it is given (`itx.fetch` in an iterate project).
 */
import { z } from "zod";

export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";
export const SUBMISSION = "urn:ietf:params:jmap:submission";

/** Fastmail's JMAP session resource. */
export const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";

/** A fetch that takes a URL and init, as `globalThis.fetch` does; `itx.fetch` wrapped in one. */
export type JmapFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type JmapOptions = {
  /** The server's JMAP session resource. Default: Fastmail's. */
  sessionUrl?: string;
  /** How requests reach the server. In an iterate project: `(input, init) => itx.fetch(new Request(input, init))`, so egress swaps the secret in. Default: `globalThis.fetch`. */
  fetch?: JmapFetch;
  /** A token itself, for use outside iterate (sent as `Bearer <token>`). */
  token?: string;
  /** The secret holding the token, for the egress placeholder. Default: `/secrets/fastmail`, field `token`. */
  secret?: { path: string; field?: string };
  /** Send every request to the session URL's own origin, not the hosts the session names. Default:
   *  true. Fastmail's session names a regional host (`ams.api.fastmail.com`) that also answers on
   *  `api.fastmail.com`, and an iterate secret is sent only to the exact origins it is pinned to, so
   *  one pin covers every call. `false` uses the session's URLs as given. */
  sessionOrigin?: boolean;
};

/** A JMAP failure, named by where it happened: `request` (the whole call) or a method
 *  (`Email/set`), with the JMAP error type (`invalidArguments`, `forbiddenFrom`, …). */
export class JmapError extends Error {
  readonly method: string;
  readonly type: string;
  constructor(method: string, type: string, description?: string) {
    super(`${method}: ${type}${description ? ` (${description})` : ""}`);
    this.name = "JmapError";
    this.method = method;
    this.type = type;
  }
}

/** One method call or response: `[name, arguments, callId]`. */
export type Invocation = [string, Record<string, unknown>, string];

export type Address = { name: string | null; email: string };
/** An address as a caller writes it: the address alone, or with a display name. */
export type AddressInput = string | { name?: string; email: string };

export type Mailbox = {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
  totalEmails: number;
  unreadEmails: number;
};

export type Identity = { id: string; name: string; email: string };

/** A message as lists show it. */
export type EmailSummary = {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  receivedAt: string;
  sentAt: string | null;
  preview: string;
  hasAttachment: boolean;
  messageId: string[];
  inReplyTo: string[];
  references: string[];
};

export type Attachment = { name: string | null; type: string; size: number; blobId: string };

/** A message with its bodies: the text and HTML parts joined, and its attachments. */
export type EmailDetail = EmailSummary & {
  text: string;
  html: string | null;
  attachments: Attachment[];
};

export type SendInput = {
  /** The sender: an address one of the account's identities covers (exactly, or by `*@domain`). */
  from: AddressInput;
  to: AddressInput[];
  cc?: AddressInput[];
  bcc?: AddressInput[];
  subject: string;
  text?: string;
  html?: string;
  /** The Message-ID(s) this answers, with or without `<…>`; threads the reply. */
  inReplyTo?: string | string[];
  references?: string | string[];
  attachments?: { name: string; type: string; data: Uint8Array | ArrayBuffer | string }[];
};

export type SendResult = {
  emailId: string;
  submissionId: string;
  /** Whether the server moved the sent message from Drafts to Sent (it is sent either way). */
  filedInSent: boolean;
};

export type SearchInput = {
  /** Words anywhere in the message. */
  text?: string;
  from?: string;
  to?: string;
  /** Received after this time (ISO 8601). */
  after?: string;
  /** A mailbox by role (`inbox`, `sent`, …) or id. */
  mailbox?: string;
  /** At most this many, newest first. Default 20. */
  limit?: number;
};

const AddressSchema = z.object({ name: z.string().nullish(), email: z.string() });
const Addresses = z
  .array(AddressSchema)
  .nullish()
  .transform((list) => (list ?? []).map(({ name, email }) => ({ name: name ?? null, email })));
const Strings = z
  .array(z.string())
  .nullish()
  .transform((list) => list ?? []);

const SessionSchema = z.object({
  apiUrl: z.string(),
  uploadUrl: z.string(),
  downloadUrl: z.string(),
  primaryAccounts: z.record(z.string(), z.string()),
  capabilities: z.record(z.string(), z.unknown()),
  username: z.string().optional(),
});

const ProblemSchema = z.object({
  type: z.string(),
  detail: z.string().optional(),
  description: z.string().optional(),
});

const ResponseSchema = z.object({
  methodResponses: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()])),
});

const MailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullish(),
  parentId: z.string().nullish(),
  totalEmails: z.number().default(0),
  unreadEmails: z.number().default(0),
});

const IdentitySchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  email: z.string(),
});

const SUMMARY_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "subject",
  "receivedAt",
  "sentAt",
  "preview",
  "hasAttachment",
  "messageId",
  "inReplyTo",
  "references",
];

const SummarySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  mailboxIds: z.record(z.string(), z.boolean()).default({}),
  keywords: z.record(z.string(), z.boolean()).default({}),
  from: Addresses,
  to: Addresses,
  cc: Addresses,
  subject: z
    .string()
    .nullish()
    .transform((subject) => subject ?? ""),
  receivedAt: z.string(),
  sentAt: z
    .string()
    .nullish()
    .transform((sentAt) => sentAt ?? null),
  preview: z.string().default(""),
  hasAttachment: z.boolean().default(false),
  messageId: Strings,
  inReplyTo: Strings,
  references: Strings,
});

const BodyPart = z.object({
  partId: z.string().nullish(),
  blobId: z.string().nullish(),
  name: z.string().nullish(),
  type: z.string(),
  size: z.number().default(0),
});

const DetailSchema = SummarySchema.extend({
  bodyValues: z.record(z.string(), z.object({ value: z.string() })).default({}),
  textBody: z.array(BodyPart).default([]),
  htmlBody: z.array(BodyPart).default([]),
  attachments: z.array(BodyPart).default([]),
});

const SetErrorSchema = z.object({ type: z.string(), description: z.string().optional() });

/** Strip a Message-ID's angle brackets: JMAP carries the id itself. */
function messageIds(ids: string | string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  return (Array.isArray(ids) ? ids : [ids]).map((id) => id.trim().replace(/^<|>$/g, ""));
}

function address(input: AddressInput): { name?: string; email: string } {
  return typeof input === "string" ? { email: input } : input;
}

/** Whether `identity` may send as `email`: the same address, or a wildcard `*@domain` over it. */
function covers(identity: string, email: string): boolean {
  const [want, have] = [email.toLowerCase(), identity.toLowerCase()];
  return have === want || (have.startsWith("*@") && want.endsWith(have.slice(1)));
}

/** A connected JMAP account: its session, and mail by method. */
export class Jmap {
  readonly #fetch: JmapFetch;
  readonly #authorization: string;
  readonly #session: z.infer<typeof SessionSchema>;

  constructor(session: unknown, fetch: JmapFetch, authorization: string) {
    this.#session = SessionSchema.parse(session);
    this.#fetch = fetch;
    this.#authorization = authorization;
  }

  /** The account a capability's methods act on (the session's primary account for it). */
  accountFor(capability: string): string {
    const accountId = this.#session.primaryAccounts[capability];
    if (!accountId)
      throw new JmapError(
        "session",
        "capabilityNotSupported",
        `this token or server has no ${capability}`,
      );
    return accountId;
  }

  /** Make `calls` in one request, `using` these capabilities; the responses in order. A method that
   *  fails throws a JmapError naming it. */
  async call(using: string[], calls: Invocation[]): Promise<Invocation[]> {
    const response = await this.#fetch(this.#session.apiUrl, {
      method: "POST",
      headers: { authorization: this.#authorization, "content-type": "application/json" },
      body: JSON.stringify({ using: [CORE, ...using], methodCalls: calls }),
    });
    if (!response.ok) {
      const problem = ProblemSchema.safeParse(await response.json().catch(() => null));
      throw new JmapError(
        "request",
        problem.success ? problem.data.type : `HTTP ${response.status}`,
        problem.success ? problem.data.detail || problem.data.description : undefined,
      );
    }
    const { methodResponses } = ResponseSchema.parse(await response.json());
    for (const [name, args, callId] of methodResponses)
      if (name === "error") {
        const method = calls.find(([, , id]) => id === callId)?.[0] ?? callId;
        const error = SetErrorSchema.safeParse(args);
        throw new JmapError(
          method,
          error.success ? error.data.type : "unknown",
          error.success ? error.data.description : undefined,
        );
      }
    return methodResponses as Invocation[];
  }

  /** One method's response arguments. */
  async method(
    using: string[],
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const [[, result]] = (await this.call(using, [[name, args, "0"]])) as [Invocation];
    return result;
  }

  async mailboxes(): Promise<Mailbox[]> {
    const result = await this.method([MAIL], "Mailbox/get", { accountId: this.accountFor(MAIL) });
    return z
      .array(MailboxSchema)
      .parse(result.list)
      .map((mailbox) => ({
        ...mailbox,
        role: mailbox.role ?? null,
        parentId: mailbox.parentId ?? null,
      }));
  }

  /** The mailbox with this role (`inbox`, `sent`, `drafts`, `trash`, …); undefined when none has it. */
  async mailbox(role: string): Promise<Mailbox | undefined> {
    return (await this.mailboxes()).find((mailbox) => mailbox.role === role);
  }

  /** The addresses the account may send as. */
  async identities(): Promise<Identity[]> {
    const result = await this.method([SUBMISSION], "Identity/get", {
      accountId: this.accountFor(SUBMISSION),
    });
    return z.array(IdentitySchema).parse(result.list);
  }

  /** Store bytes as a blob (an attachment's body), by the session's upload URL. */
  async upload(
    data: Uint8Array | ArrayBuffer | string,
    type: string,
  ): Promise<{ blobId: string; size: number }> {
    const accountId = this.accountFor(MAIL);
    const response = await this.#fetch(
      this.#session.uploadUrl.replace("{accountId}", encodeURIComponent(accountId)),
      {
        method: "POST",
        headers: { authorization: this.#authorization, "content-type": type },
        body: typeof data === "string" ? data : new Uint8Array(data),
      },
    );
    if (!response.ok) throw new JmapError("upload", `HTTP ${response.status}`);
    return z.object({ blobId: z.string(), size: z.number() }).parse(await response.json());
  }

  /** Send a message from one of the account's identities: written to Drafts, submitted, and on
   *  success moved to Sent, so the mailbox keeps a copy as if a person had sent it. */
  async send(input: SendInput): Promise<SendResult> {
    const mailAccount = this.accountFor(MAIL);
    const submissionAccount = this.accountFor(SUBMISSION);
    const from = address(input.from);
    const [mailboxes, identities] = await Promise.all([this.mailboxes(), this.identities()]);
    const drafts = mailboxes.find((mailbox) => mailbox.role === "drafts");
    const sent = mailboxes.find((mailbox) => mailbox.role === "sent");
    if (!drafts || !sent)
      throw new JmapError("send", "noMailbox", "the account has no Drafts or no Sent mailbox");
    const identity = identities.find((candidate) => covers(candidate.email, from.email));
    if (!identity)
      throw new JmapError(
        "send",
        "forbiddenFrom",
        `no identity covers ${from.email}; the account's: ${identities.map((i) => i.email).join(", ") || "none"}`,
      );
    if (input.text === undefined && input.html === undefined)
      throw new JmapError("send", "invalidArguments", "a message needs text or html");
    const attachments = await Promise.all(
      (input.attachments ?? []).map(async ({ name, type, data }) => ({
        ...(await this.upload(data, type)),
        name,
        type,
        disposition: "attachment",
      })),
    );
    const bodyValues: Record<string, { value: string }> = {};
    if (input.text !== undefined) bodyValues.text = { value: input.text };
    if (input.html !== undefined) bodyValues.html = { value: input.html };
    const email: Record<string, unknown> = {
      mailboxIds: { [drafts.id]: true },
      keywords: { $draft: true, $seen: true },
      from: [from],
      to: input.to.map(address),
      subject: input.subject,
      bodyValues,
    };
    if (input.cc?.length) email.cc = input.cc.map(address);
    if (input.bcc?.length) email.bcc = input.bcc.map(address);
    if (input.inReplyTo) email.inReplyTo = messageIds(input.inReplyTo);
    if (input.references) email.references = messageIds(input.references);
    if (input.text !== undefined) email.textBody = [{ partId: "text", type: "text/plain" }];
    if (input.html !== undefined) email.htmlBody = [{ partId: "html", type: "text/html" }];
    if (attachments.length) email.attachments = attachments;
    const responses = await this.call(
      [MAIL, SUBMISSION],
      [
        ["Email/set", { accountId: mailAccount, create: { draft: email } }, "0"],
        [
          "EmailSubmission/set",
          {
            accountId: submissionAccount,
            create: { send: { identityId: identity.id, emailId: "#draft" } },
            onSuccessUpdateEmail: {
              "#send": {
                [`mailboxIds/${drafts.id}`]: null,
                [`mailboxIds/${sent.id}`]: true,
                "keywords/$draft": null,
              },
            },
          },
          "1",
        ],
      ],
    );
    const created = (name: string, key: string) => {
      const args = responses.find(
        ([method, , id]) => method === name && (id === "0" || id === "1"),
      )?.[1];
      const failure = SetErrorSchema.safeParse(
        (args?.notCreated as Record<string, unknown>)?.[key],
      );
      if (failure.success) throw new JmapError(name, failure.data.type, failure.data.description);
      return z.object({ id: z.string() }).parse((args?.created as Record<string, unknown>)?.[key])
        .id;
    };
    const emailId = created("Email/set", "draft");
    const submissionId = created("EmailSubmission/set", "send");
    // the implicit Email/set the server runs for onSuccessUpdateEmail comes last
    const moved = responses.filter(([method]) => method === "Email/set").at(-1)?.[1];
    const filedInSent =
      responses.filter(([method]) => method === "Email/set").length > 1 &&
      !(moved?.notUpdated as Record<string, unknown> | undefined)?.[emailId];
    return { emailId, submissionId, filedInSent };
  }

  /** Messages matching `input`, newest first. */
  async search(input: SearchInput = {}): Promise<EmailSummary[]> {
    const accountId = this.accountFor(MAIL);
    const filter: Record<string, unknown> = {};
    if (input.text) filter.text = input.text;
    if (input.from) filter.from = input.from;
    if (input.to) filter.to = input.to;
    if (input.after) filter.after = new Date(input.after).toISOString();
    if (input.mailbox) {
      const byRole = await this.mailbox(input.mailbox);
      filter.inMailbox = byRole?.id ?? input.mailbox;
    }
    const responses = await this.call(
      [MAIL],
      [
        [
          "Email/query",
          {
            accountId,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: input.limit ?? 20,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: SUMMARY_PROPERTIES,
          },
          "g",
        ],
      ],
    );
    return z.array(SummarySchema).parse(responses[1]![1].list);
  }

  /** A thread's messages, oldest first. */
  async getThread(threadId: string): Promise<EmailSummary[]> {
    const accountId = this.accountFor(MAIL);
    const responses = await this.call(
      [MAIL],
      [
        ["Thread/get", { accountId, ids: [threadId] }, "t"],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
            properties: SUMMARY_PROPERTIES,
          },
          "g",
        ],
      ],
    );
    return z
      .array(SummarySchema)
      .parse(responses[1]![1].list)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /** One message; with `bodies`, its text and HTML and attachments too. Null when it does not exist. */
  async getEmail(id: string, options: { bodies?: boolean } = {}): Promise<EmailDetail | null> {
    const result = await this.method([MAIL], "Email/get", {
      accountId: this.accountFor(MAIL),
      ids: [id],
      properties: options.bodies
        ? [...SUMMARY_PROPERTIES, "bodyValues", "textBody", "htmlBody", "attachments"]
        : SUMMARY_PROPERTIES,
      fetchTextBodyValues: !!options.bodies,
      fetchHTMLBodyValues: !!options.bodies,
    });
    const [found] = z.array(DetailSchema).parse(result.list);
    if (!found) return null;
    const { bodyValues, textBody, htmlBody, attachments, ...summary } = found;
    const joined = (parts: z.infer<typeof BodyPart>[]) =>
      parts.map((part) => (part.partId ? (bodyValues[part.partId]?.value ?? "") : "")).join("\n");
    return {
      ...summary,
      text: joined(textBody.filter((part) => part.type === "text/plain")),
      html: htmlBody.some((part) => part.type === "text/html")
        ? joined(htmlBody.filter((part) => part.type === "text/html"))
        : null,
      attachments: attachments.map((part) => ({
        name: part.name ?? null,
        type: part.type,
        size: part.size,
        blobId: part.blobId ?? "",
      })),
    };
  }
}

/** Connect to a JMAP server: read its session and answer the account. */
export async function connectJmap(options: JmapOptions = {}): Promise<Jmap> {
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const secret = options.secret ?? { path: "/secrets/fastmail", field: "token" };
  const authorization = options.token
    ? `Bearer ${options.token}`
    : `Bearer getSecret(${JSON.stringify(secret.path)}${secret.field ? `, { field: ${JSON.stringify(secret.field)} }` : ""})`;
  const sessionUrl = options.sessionUrl ?? FASTMAIL_SESSION_URL;
  const response = await fetch(sessionUrl, {
    headers: { authorization, accept: "application/json" },
  });
  if (!response.ok) {
    const problem = ProblemSchema.safeParse(await response.json().catch(() => null));
    throw new JmapError(
      "session",
      problem.success ? problem.data.type : `HTTP ${response.status}`,
      problem.success ? problem.data.detail || problem.data.description : undefined,
    );
  }
  const session = SessionSchema.parse(await response.json());
  if (options.sessionOrigin !== false) {
    // a string swap, not `new URL`: the upload and download URLs are templates (`{accountId}`)
    const origin = new URL(sessionUrl).origin;
    const onOrigin = (url: string) => url.replace(/^https?:\/\/[^/]+/i, origin);
    session.apiUrl = onOrigin(session.apiUrl);
    session.uploadUrl = onOrigin(session.uploadUrl);
    session.downloadUrl = onOrigin(session.downloadUrl);
  }
  return new Jmap(session, fetch, authorization);
}

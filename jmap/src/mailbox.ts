import { JamClient } from "jmap-jam";
import type { FastmailCopy } from "./forwarded.js";

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const MASKED_EMAIL = "https://www.fastmail.com/dev/maskedemail";

export type Address = { name: string | null; email: string };
/** An address as a caller writes it: the address alone, or with a display name. */
export type AddressInput = string | { name?: string; email: string };
/** A folder, which JMAP calls a mailbox. */
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
  /** The Message-ID(s) this answers, with or without `<…>`: it threads the reply. */
  inReplyTo?: string | string[];
  references?: string | string[];
  attachments?: { name: string; type: string; data: Uint8Array | ArrayBuffer | string }[];
};
export type SendResult = {
  emailId: string;
  submissionId: string;
  /** Whether the server moved the sent message from Drafts to Sent. It is sent either way. */
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
export type MaskedEmailState = "pending" | "enabled" | "disabled" | "deleted";
export type MaskedEmail = {
  id: string;
  email: string;
  state: MaskedEmailState;
  forDomain: string;
  description: string;
  lastMessageAt: string | null;
  createdAt: string;
};
export type CreateMaskedEmail = {
  /** The site it is for, such as `https://shop.example`. */
  forDomain: string;
  /** Why it exists, in a few words. */
  description: string;
  /** How the address starts, when wanted: at most 64 of a-z, 0-9 and `_`. */
  emailPrefix?: string;
  /** `enabled` (the default) delivers at once. Fastmail deletes a `pending` one after 24 hours,
   *  unless mail arrives first. */
  state?: "enabled" | "pending";
};

/** The account, by method: what `mailbox()` returns. */
export type JmapMailbox = {
  /** Send from one of the account's identities: written to Drafts, submitted, and once sent moved
   *  to Sent, so the mailbox keeps a copy as a person's would. */
  send(input: SendInput): Promise<SendResult>;
  /** Messages matching `input`, newest first. */
  search(input?: SearchInput): Promise<EmailSummary[]>;
  /** A thread's messages, oldest first. */
  getThread(threadId: string): Promise<EmailSummary[]>;
  /** One message; with `bodies`, its text, HTML and attachments too. Null when it does not exist. */
  getEmail(id: string, options?: { bodies?: boolean }): Promise<EmailDetail | null>;
  mailboxes(): Promise<Mailbox[]>;
  /** The mailbox with this role (`inbox`, `sent`, `drafts`, …); undefined when none has it. */
  mailbox(role: string): Promise<Mailbox | undefined>;
  /** The addresses the account may send as. */
  identities(): Promise<Identity[]>;
  /** Bytes stored as a blob, such as an attachment's body. */
  upload(
    data: Uint8Array | ArrayBuffer | string,
    type: string,
  ): Promise<{ blobId: string; size: number }>;
  /** Every masked address of the account, deleted ones included. */
  listMaskedEmails(): Promise<MaskedEmail[]>;
  /** A new masked address for one site. */
  createMaskedEmail(input: CreateMaskedEmail): Promise<MaskedEmail>;
  /** `enabled` delivers; `disabled` sends its mail to the trash; `deleted` bounces it. */
  setMaskedEmailState(id: string, state: "enabled" | "disabled" | "deleted"): Promise<void>;
};

type Raw = Record<string, any>;
/** jam as these helpers call it: its own types know neither Fastmail's Masked Email methods nor the
 *  objects built here. */
type Jam = {
  authHeader: string;
  session: Promise<Raw>;
  request(call: [string, Raw], options: { using: string[] }): Promise<[Raw]>;
  requestMany(calls: (t: any) => Raw, options: { createdIds?: {} }): Promise<[Raw, Raw]>;
  uploadBlob(accountId: string, body: Blob): Promise<{ blobId: string; size: number }>;
};

/** What a list of messages shows of each one. */
const SUMMARY = [
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
/** A message as lists show it, with an empty value where JMAP answers null. */
const summaryOf = (raw: Raw): EmailSummary => ({
  ...(raw as EmailSummary),
  subject: raw.subject ?? "",
  from: raw.from ?? [],
  to: raw.to ?? [],
  cc: raw.cc ?? [],
  messageId: raw.messageId ?? [],
  inReplyTo: raw.inReplyTo ?? [],
  references: raw.references ?? [],
});
const byReceived = (a: EmailSummary, b: EmailSummary) => a.receivedAt.localeCompare(b.receivedAt);
const address = (input: AddressInput) => (typeof input === "string" ? { email: input } : input);
/** Message-IDs without their angle brackets: JMAP carries the id itself. */
const messageIds = (ids: string | string[]) =>
  [ids].flat().map((id) => id.trim().replace(/^<|>$/g, ""));
/** Whether an identity may send as `email`: the same address, or a wildcard `*@domain` over it. */
const covers = (identity: string, email: string) => {
  const [want, have] = [email.toLowerCase(), identity.toLowerCase()];
  return have === want || (have.startsWith("*@") && want.endsWith(have.slice(1)));
};
/** What jam threw, in words: an HTTP error's text or problem, a method's error, a list of those, or
 *  an Error. */
const explain = (thrown: unknown): string => {
  if (Array.isArray(thrown)) return thrown.map(explain).join("; ");
  if (thrown instanceof Error)
    return thrown.cause ? `${thrown.message}: ${explain(thrown.cause)}` : thrown.message;
  if (typeof thrown === "string") return thrown.trim();
  const { type, description, detail } = (thrown ?? {}) as Raw;
  return `${type ?? "unknown"}${description || detail ? ` (${description || detail})` : ""}`;
};
const failure = (what: string, thrown: unknown) =>
  new Error(`${what}: ${explain(thrown)}`, { cause: thrown });
/** `promise`, with what it throws as one Error that names `what`. */
const guard = <T>(what: string, promise: Promise<T>): Promise<T> =>
  promise.catch((thrown) => Promise.reject(failure(what, thrown)));

/** The account's session and calls, which `mailbox()` and `fastmailCopies()` build on. jam reads the
 *  session at the first call, and the session is kept unless that read fails. */
function connect(options: { secret: string; sessionUrl?: string }) {
  const sessionUrl = options.sessionUrl ?? "https://api.fastmail.com/jmap/session";
  // Fastmail's session names a regional host (such as ams.api.fastmail.com) that answers on the
  // session URL's origin too, and egress sends a secret only to the exact origins it is pinned to.
  // A string swap, since the upload and download URLs are templates (`{accountId}`).
  const onOrigin = (url: string) => url.replace(/^https?:\/\/[^/]+/i, new URL(sessionUrl).origin);
  let jam: Jam | undefined;
  const client = (): Jam => {
    if (jam) return jam;
    const bearerToken = `getSecret("${options.secret}", { field: "token" })`;
    const made = new JamClient({ sessionUrl, bearerToken }) as unknown as Jam;
    // jam takes no fetch and no API URL, but every request reads its URLs from this session
    made.session = made.session
      .then((session) => {
        if (typeof session?.apiUrl !== "string") throw new Error("no apiUrl");
        const { apiUrl, uploadUrl, downloadUrl } = session;
        const urls = { apiUrl: onOrigin(apiUrl), uploadUrl: onOrigin(uploadUrl) };
        return { ...session, ...urls, downloadUrl: onOrigin(downloadUrl) };
      })
      .catch(async () => {
        jam = undefined;
        // jam reads the session as JSON and drops the status, so ask again to say why. Egress
        // answers a secret it may not send with a 502 whose text names the origins it is pinned to.
        const answer = await fetch(sessionUrl, { headers: { authorization: made.authHeader } });
        const text = (await answer.text()).trim().slice(0, 500);
        throw new Error(
          `the JMAP session at ${sessionUrl} answered HTTP ${answer.status}: ${text}`,
        );
      });
    return (jam = made);
  };
  const account = async (capability: string): Promise<string> => {
    const id = (await client().session).primaryAccounts?.[capability];
    if (!id)
      throw new Error(
        `the JMAP session has no account for ${capability}: the token lacks that scope`,
      );
    return id;
  };
  /** One method's answer. */
  const call = async (method: string, args: Raw, using: string[] = []) =>
    (await guard(method, client().request([method, args], { using })))[0];
  /** Methods in one request, by call id: `calls` writes each as jam's `t.Email.get({ … })`. */
  const callMany = (what: string, calls: (t: any) => Raw, createdIds?: {}) =>
    guard(what, client().requestMany(calls, { createdIds }));
  const mailboxes = async (): Promise<Mailbox[]> => {
    const properties = ["id", "name", "role", "parentId", "totalEmails", "unreadEmails"];
    return (await call("Mailbox/get", { accountId: await account(MAIL), properties })).list;
  };
  const byRole = async (role: string) => (await mailboxes()).find((box) => box.role === role);
  const identities = async (): Promise<Identity[]> => {
    const accountId = await account(SUBMISSION);
    return (await call("Identity/get", { accountId, properties: ["id", "name", "email"] })).list;
  };
  const upload = async (data: Uint8Array | ArrayBuffer | string, type: string) => {
    const accountId = await account(MAIL);
    // fetch sends a Blob's type as the request's content type, which becomes the blob's type
    const blob = new Blob([data], { type });
    const { blobId, size } = await guard("upload", client().uploadBlob(accountId, blob));
    return { blobId, size };
  };
  return { account, call, callMany, mailboxes, byRole, identities, upload };
}

/** A JMAP account for the project's own code: Fastmail's, unless `sessionUrl` names another server.
 *  Its token is the `token` field of `secret`, sent as the placeholder
 *  `getSecret("<secret>", { field: "token" })`. In every worker the platform loads, the global
 *  `fetch` is the project's egress, which swaps the token in toward the origins the secret is pinned
 *  to. Every request goes to the session URL's origin, so that origin is the one pin it needs. */
export function mailbox(options: { secret: string; sessionUrl?: string }): JmapMailbox {
  const { account, call, callMany, mailboxes, byRole, identities, upload } = connect(options);
  const masked = async (method: string, args: Raw) =>
    call(method, { accountId: await account(MASKED_EMAIL), ...args }, [MASKED_EMAIL]);
  return {
    async send(input) {
      const { text, html } = input;
      if (text === undefined && html === undefined)
        throw new Error("send: a message needs text or html");
      const from = address(input.from);
      const [folders, senders, mailAccount, submissionAccount] = await Promise.all([
        mailboxes(),
        identities(),
        account(MAIL),
        account(SUBMISSION),
      ]);
      const drafts = folders.find((box) => box.role === "drafts")?.id;
      const sent = folders.find((box) => box.role === "sent")?.id;
      if (!drafts || !sent) throw new Error("send: the account has no Drafts or no Sent mailbox");
      // before anything is written: a refused submission leaves its draft in Drafts
      const identity = senders.find((candidate) => covers(candidate.email, from.email));
      if (!identity) {
        const theirs = senders.map((sender) => sender.email).join(", ") || "none";
        throw new Error(`send: no identity covers ${from.email}; the account's: ${theirs}`);
      }
      const attachments = await Promise.all(
        (input.attachments ?? []).map(async ({ name, type, data }) => {
          const { blobId, size } = await upload(data, type);
          return { blobId, size, name, type, disposition: "attachment" };
        }),
      );
      const bodyValues: Raw = {};
      if (text !== undefined) bodyValues.text = { value: text };
      if (html !== undefined) bodyValues.html = { value: html };
      const email = {
        mailboxIds: { [drafts]: true },
        keywords: { $draft: true, $seen: true },
        from: [from],
        to: input.to.map(address),
        cc: input.cc?.length ? input.cc.map(address) : undefined,
        bcc: input.bcc?.length ? input.bcc.map(address) : undefined,
        subject: input.subject,
        inReplyTo: input.inReplyTo && messageIds(input.inReplyTo),
        references: input.references && messageIds(input.references),
        bodyValues,
        textBody: text === undefined ? undefined : [{ partId: "text", type: "text/plain" }],
        htmlBody: html === undefined ? undefined : [{ partId: "html", type: "text/html" }],
        attachments: attachments.length ? attachments : undefined,
      };
      // `createdIds` asks the server for the id behind each creation id ("#draft", "#send")
      const [{ write, submit }, { createdIds }] = await callMany(
        "send",
        (t) => ({
          write: t.Email.set({ accountId: mailAccount, create: { draft: email } }),
          submit: t.EmailSubmission.set({
            accountId: submissionAccount,
            create: { send: { identityId: identity.id, emailId: "#draft" } },
            onSuccessUpdateEmail: {
              "#send": {
                [`mailboxIds/${drafts}`]: null,
                [`mailboxIds/${sent}`]: true,
                "keywords/$draft": null,
              },
            },
          }),
        }),
        {},
      );
      const emailId = createdIds?.draft;
      const submissionId = createdIds?.send;
      if (!emailId || !submissionId)
        throw failure("send", write.notCreated?.draft ?? submit.notCreated?.send ?? "not sent");
      // The server answers onSuccessUpdateEmail with an Email/set of its own, under the
      // submission's call id, so in `submit` it stands in place of the submission's answer.
      return { emailId, submissionId, filedInSent: emailId in (submit.updated ?? {}) };
    },
    async search(input = {}) {
      const accountId = await account(MAIL);
      const inMailbox = input.mailbox && ((await byRole(input.mailbox))?.id ?? input.mailbox);
      const filter = {
        text: input.text || undefined,
        from: input.from || undefined,
        to: input.to || undefined,
        after: input.after ? new Date(input.after).toISOString() : undefined,
        inMailbox: inMailbox || undefined,
      };
      const [{ emails }] = await callMany("search", (t) => {
        const sort = [{ property: "receivedAt", isAscending: false }];
        const query = t.Email.query({ accountId, filter, sort, limit: input.limit ?? 20 });
        const ids = query.$ref("/ids");
        return { query, emails: t.Email.get({ accountId, ids, properties: SUMMARY }) };
      });
      return emails.list
        .map(summaryOf)
        .sort((a: EmailSummary, b: EmailSummary) => byReceived(b, a));
    },
    async getThread(threadId) {
      const accountId = await account(MAIL);
      const [{ emails }] = await callMany("getThread", (t) => {
        const thread = t.Thread.get({ accountId, ids: [threadId] });
        const ids = thread.$ref("/list/*/emailIds");
        return { thread, emails: t.Email.get({ accountId, ids, properties: SUMMARY }) };
      });
      return emails.list.map(summaryOf).sort(byReceived);
    },
    async getEmail(id, { bodies = false } = {}) {
      const parts = bodies ? ["bodyValues", "textBody", "htmlBody", "attachments"] : [];
      const { list } = await call("Email/get", {
        accountId: await account(MAIL),
        ids: [id],
        properties: [...SUMMARY, ...parts],
        fetchTextBodyValues: bodies,
        fetchHTMLBodyValues: bodies,
      });
      if (!list[0]) return null;
      const { bodyValues = {}, textBody = [], htmlBody = [], attachments = [], ...rest } = list[0];
      const joined = (parts: Raw[], type: string) =>
        parts
          .filter((part) => part.type === type)
          .map((part) => bodyValues[part.partId]?.value ?? "")
          .join("\n");
      const hasHtml = htmlBody.some((part: Raw) => part.type === "text/html");
      return {
        ...summaryOf(rest),
        text: joined(textBody, "text/plain"),
        html: hasHtml ? joined(htmlBody, "text/html") : null,
        attachments: attachments.map(({ name, type, size, blobId }: Raw) => ({
          name,
          type,
          size,
          blobId,
        })),
      };
    },
    mailboxes,
    mailbox: byRole,
    identities,
    upload,
    async listMaskedEmails() {
      const fields = ["id", "email", "state", "forDomain", "description", "lastMessageAt"];
      return (await masked("MaskedEmail/get", { properties: [...fields, "createdAt"] })).list;
    },
    async createMaskedEmail({ forDomain, description, emailPrefix, state = "enabled" }) {
      if (emailPrefix !== undefined && !/^[a-z0-9_]{1,64}$/.test(emailPrefix))
        throw new Error("MaskedEmail/set: emailPrefix is at most 64 of a-z, 0-9 and _");
      const create = { new: { state, forDomain, description, emailPrefix } };
      const { created, notCreated } = await masked("MaskedEmail/set", { create });
      if (notCreated?.new) throw failure("MaskedEmail/set", notCreated.new);
      // the server answers what it set (`id`, `email`, `createdAt`, …); the rest is what was asked
      const asked = { state, forDomain, description, lastMessageAt: null };
      return { ...asked, createdAt: new Date().toISOString(), ...created?.new };
    },
    async setMaskedEmailState(id, state) {
      const { notUpdated } = await masked("MaskedEmail/set", { update: { [id]: { state } } });
      if (notUpdated?.[id]) throw failure("MaskedEmail/set", notUpdated[id]);
    },
  };
}

/** The mailbox's own copies of a message, by its Message-ID, outside Sent: what `fastmailVerdict`
 *  reads. Three tries, two seconds apart, since a copy Fastmail forwards can reach the platform
 *  before Fastmail's search finds its own. */
export async function fastmailCopies(
  options: { secret: string; sessionUrl?: string },
  messageId: string,
): Promise<FastmailCopy[]> {
  const { account, callMany, byRole } = connect(options);
  const [accountId, sent] = await Promise.all([account(MAIL), byRole("sent")]);
  const properties = ["from", "subject", "mailboxIds", "headers", "textBody", "bodyValues"];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const [{ emails }] = await callMany("fastmailCopies", (t) => {
      const filter = { header: ["Message-ID", messageId] };
      const query = t.Email.query({ accountId, filter, limit: 5 });
      const ids = query.$ref("/ids");
      return {
        query,
        emails: t.Email.get({ accountId, ids, properties, fetchTextBodyValues: true }),
      };
    });
    const copies = emails.list.filter((email: Raw) => !(sent && email.mailboxIds[sent.id]));
    if (copies.length)
      return copies.map(({ from, subject, textBody, bodyValues, headers }: Raw) => ({
        from: from?.[0]?.email ?? "",
        subject: subject ?? "",
        text: (textBody ?? [])
          .map((part: Raw) => bodyValues?.[part.partId]?.value ?? "")
          .join("\n"),
        headers: headers ?? [],
      }));
  }
  return [];
}

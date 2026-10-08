# JMAP

A mailbox for an iterate project over [JMAP](https://jmap.io), the standard (RFC 8620, RFC 8621)
that Fastmail designed and serves natively: send from it, search it, read whole threads. And
Fastmail's [Masked Email](https://www.fastmail.com/dev/#masked-email-api): throwaway addresses an
agent makes for one site and switches off later.

There is no client to install. An agent's script, or the project's own code, calls Fastmail's JMAP
API with plain `fetch`: [Using the mailbox](#using-the-mailbox) has every call. The package,
`iterate-jmap`, is only the mailbox's card on the Dash.

Mail the project sends goes through the mailbox itself: it is written to Drafts, submitted, and moved
to Sent. So the mailbox holds everything the project sent and received, as a person's mailbox would,
and a person can read it there.

The project never holds the token. It lives in a secret, `/secrets/fastmail`, pinned to
`https://api.fastmail.com`. A request names it with a placeholder, and iterate's egress swaps the
token in on the way out. In every worker the platform loads (a run script, the config worker) the
global `fetch` is that egress.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 0. Before you start: a mailbox and a token

The person does this in Fastmail:

1. **A Fastmail user of its own for the project's mail**, not an alias on their own user. A token
   reaches its whole user, so a separate user keeps the project out of the person's mail.
2. **A token for that user:** signed in as it, Settings → Privacy & Security → Integrations → API
   tokens → New API token. Give it Mail (not read-only) and Email submission, and Masked Email if
   the project should make throwaway addresses.
3. **To read the project's mail beside their own** (optional): Fastmail lets users of one account
   share folders. Signed in as the project's user, share its Inbox and Sent with the person's user.

## 1. The token, as a secret

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/fastmail",
    egress: { urls: ["https://api.fastmail.com"] },
    description:
      "The Fastmail API token of the project's own mailbox. It is only ever sent to api.fastmail.com.",
    fields: [{ name: "token", label: "API token" }],
  });
```

Send the person the returned `url` and wait until they say it is saved.

## 2. The card on the Dash

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the
package (built by this repo's CI and served by pkg.pr.new, never npm), adds `jmap()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it:

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-jmap";
const IMPORT = 'import { jmap } from "iterate-jmap";';
const ELEMENT = "jmap()";
const MEMBER = "";
const FILES = {};
```

`jmap()` has no host of its own. Its install hook (`project/worker-updated`) puts a Mailbox card on
the Dash's Integrations page: "Set up by your coding agent: see the recipe" until the token exists,
with a link to this recipe, and "ok" after.

Earlier builds of this package shipped a client (`connectJmap`, `maskedEmails`), and an earlier
version of this recipe added `mail.ts` and a `mailbox()` member to `worker.ts` that use it. Move any
code that imports the client to `fetch` first, in a commit of its own: otherwise the script's probe
fails on the newer build and nothing is committed.

## 3. Prove it

Run the script in [The session, and one call](#the-session-and-one-call) as it is. It reads the
session and lists the mailboxes. Mailboxes back, with Inbox, Drafts and Sent among them, is the
proof.

Then write into the project's `AGENTS.md` the mailbox's address, that agents call it with `fetch` and
the token's placeholder, and a link to this README's
[Using the mailbox](https://github.com/jonastemplestein/iterategrations/tree/main/jmap#using-the-mailbox).

## Using the mailbox

Read this before the first call. Every call is plain `fetch`. The examples are scripts for `run`;
the config repo's code (`worker.ts`, or a file it imports) makes the same requests with the same
global `fetch`.

- **The placeholder:** `authorization: Bearer getSecret("/secrets/fastmail", { field: "token" })`,
  on every request.
- **The origin:** `https://api.fastmail.com`, the only one the secret is pinned to. Fastmail's
  session names a regional host (such as `ams.api.fastmail.com`), which also answers on
  `api.fastmail.com`: put every URL the session gives on `https://api.fastmail.com`.
- **The shape:** one `GET` of the session, `https://api.fastmail.com/jmap/session`, then one `POST`
  to its `apiUrl` per task, with `using` (the capabilities its calls need) and `methodCalls`
  (`[name, arguments, call id]`, run in order). The answer's `methodResponses` come back in the
  same order, each with its call's id.
- **The capabilities.** Each method's `accountId` is the session's `primaryAccounts[<capability>]`:
  - `urn:ietf:params:jmap:core`: in every request's `using`.
  - `urn:ietf:params:jmap:mail` (the token's Mail scope): `Mailbox/get`, `Email/query`,
    `Email/get`, `Thread/get` and `Email/set`.
  - `urn:ietf:params:jmap:submission` (its Email submission scope): `Identity/get` and
    `EmailSubmission/set`.
  - `https://www.fastmail.com/dev/maskedemail` (its Masked Email scope): `MaskedEmail/get` and
    `MaskedEmail/set`.
- **Everything else:** [RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) (the core: the session,
  requests, `/get`, `/set`, `/query`, references to earlier results, blobs),
  [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) (mail: mailboxes, threads, messages,
  identities, sending), and Fastmail's [developer docs](https://www.fastmail.com/dev/) with its
  [Masked Email API](https://www.fastmail.com/dev/#masked-email-api).

### The session, and one call

Every task below starts from this script. As it is, it lists the mailboxes:

```js
async (itx) => {
  const CORE = "urn:ietf:params:jmap:core";
  const MAIL = "urn:ietf:params:jmap:mail";
  const SUBMISSION = "urn:ietf:params:jmap:submission";
  const MASKED_EMAIL = "https://www.fastmail.com/dev/maskedemail";
  // what a list of messages shows of each one
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
  const authorization = 'Bearer getSecret("/secrets/fastmail", { field: "token" })';

  // The session: where calls go, and the account each capability acts on
  const response = await fetch("https://api.fastmail.com/jmap/session", {
    headers: { authorization, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`session: HTTP ${response.status} ${await response.text()}`);
  const session = await response.json();
  // its URLs name a regional host, which also answers on the origin the secret is pinned to
  const pinned = (url) => url.replace(/^https?:\/\/[^/]+/i, "https://api.fastmail.com");
  const mailAccount = session.primaryAccounts[MAIL];
  const submissionAccount = session.primaryAccounts[SUBMISSION];
  const maskedEmailAccount = session.primaryAccounts[MASKED_EMAIL]; // none without that scope

  // One request: its method calls run in order, and their responses come back in that order
  const call = async (using, methodCalls) => {
    const answer = await fetch(pinned(session.apiUrl), {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!answer.ok) throw new Error(`request: HTTP ${answer.status} ${await answer.text()}`);
    const { methodResponses } = await answer.json();
    const error = methodResponses.find(([name]) => name === "error");
    if (error) throw new Error(`call ${error[2]}: ${error[1].type} ${error[1].description ?? ""}`);
    return methodResponses;
  };

  // The task: the mailboxes
  const [[, mailboxes]] = await call(
    [CORE, MAIL],
    [["Mailbox/get", { accountId: mailAccount }, "0"]],
  );
  return mailboxes.list.map(({ id, name, role }) => ({ id, name, role }));
};
```

Each task below is the script's last lines: keep everything above `// The task`, and put the task in
place of the rest.

- A mailbox's `role` says what it is (`inbox`, `drafts`, `sent`, `trash`, …). Its `id` differs in
  every account, so find a mailbox by its role.
- A method that fails answers `["error", { type, description }, call id]` in place of its response,
  and the calls after it still run (`call` throws on the first). A request refused as a whole is an
  HTTP error with a JSON body (`type`, `detail`).
- A `/set` lists each record it could not create or update under `notCreated` or `notUpdated`, as
  `{ type, description }`.

### Search, and read

```js
// The task: the newest messages in the Inbox since 1 October
const [[, mailboxes]] = await call(
  [CORE, MAIL],
  [["Mailbox/get", { accountId: mailAccount }, "0"]],
);
const inbox = mailboxes.list.find((mailbox) => mailbox.role === "inbox");
const [, [, found]] = await call(
  [CORE, MAIL],
  [
    [
      "Email/query",
      {
        accountId: mailAccount,
        filter: { inMailbox: inbox.id, after: "2026-10-01T00:00:00Z" },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: 20,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId: mailAccount,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: SUMMARY,
      },
      "g",
    ],
  ],
);
return found.list.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
```

- `"#ids"` is a reference to an earlier result in the same request: `Email/get` takes the ids that
  `Email/query` found, so one request searches and reads.
- `inMailbox` takes a mailbox's id, not its role. `filter` also takes `text` (words anywhere in the
  message), `from` and `to`; `after` is a UTC date-time.
  [RFC 8621, section 4.4.1](https://www.rfc-editor.org/rfc/rfc8621#section-4.4.1) has every
  condition.
- `Email/get` may answer in any order, so sort by `receivedAt`.

One message with its bodies:

```js
// The task: one message, with its text, HTML and attachments
const [[, got]] = await call(
  [CORE, MAIL],
  [
    [
      "Email/get",
      {
        accountId: mailAccount,
        ids: ["<the message's id>"],
        properties: [...SUMMARY, "bodyValues", "textBody", "htmlBody", "attachments"],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
      },
      "0",
    ],
  ],
);
const [message] = got.list; // none when got.notFound names the id
const { bodyValues, textBody, htmlBody, ...summary } = message;
const joined = (parts, type) =>
  parts
    .filter((part) => part.type === type)
    .map((part) => bodyValues[part.partId]?.value ?? "")
    .join("\n");
return { ...summary, text: joined(textBody, "text/plain"), html: joined(htmlBody, "text/html") };
```

- `fetchTextBodyValues` and `fetchHTMLBodyValues` put each body part's content into `bodyValues`, by
  its `partId`. The text is the `text/plain` parts of `textBody`, in order; the HTML is the
  `text/html` parts of `htmlBody`.
- `attachments` gives each one's `name`, `type`, `size` and `blobId`. The session's `downloadUrl`
  (on `https://api.fastmail.com` too) gives a blob's bytes:
  [RFC 8620, section 6.2](https://www.rfc-editor.org/rfc/rfc8620#section-6.2).

### A whole thread

```js
// The task: a thread's messages, oldest first
const [, [, thread]] = await call(
  [CORE, MAIL],
  [
    ["Thread/get", { accountId: mailAccount, ids: ["<a message's threadId>"] }, "t"],
    [
      "Email/get",
      {
        accountId: mailAccount,
        "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: SUMMARY,
      },
      "g",
    ],
  ],
);
return thread.list.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
```

`/list/*/emailIds` takes the message ids of every thread `Thread/get` answers, as one list.

### Send

```js
// The task: send from the project's address, as a reply
const sender = "project@your-domain.example"; // an address one of the identities covers
const [[, mailboxes]] = await call(
  [CORE, MAIL],
  [["Mailbox/get", { accountId: mailAccount }, "0"]],
);
const [[, identities]] = await call(
  [CORE, SUBMISSION],
  [["Identity/get", { accountId: submissionAccount }, "0"]],
);
const drafts = mailboxes.list.find((mailbox) => mailbox.role === "drafts").id;
const sent = mailboxes.list.find((mailbox) => mailbox.role === "sent").id;
const identity = identities.list.find(({ email }) => {
  const [want, have] = [sender.toLowerCase(), email.toLowerCase()];
  return have === want || (have.startsWith("*@") && want.endsWith(have.slice(1)));
});
if (!identity)
  throw new Error(`no identity covers ${sender}: ${identities.list.map((i) => i.email)}`);

const [[, written], [, submitted], filed] = await call(
  [CORE, MAIL, SUBMISSION],
  [
    [
      "Email/set",
      {
        accountId: mailAccount,
        create: {
          draft: {
            mailboxIds: { [drafts]: true },
            keywords: { $draft: true, $seen: true },
            from: [{ email: sender }],
            to: [{ email: "someone@example.com" }],
            subject: "Re: the order",
            inReplyTo: ["message-id-of-their-mail@example.com"],
            bodyValues: { text: { value: "Thanks, all received." } },
            textBody: [{ partId: "text", type: "text/plain" }],
          },
        },
      },
      "0",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: submissionAccount,
        create: { send: { identityId: identity.id, emailId: "#draft" } },
        onSuccessUpdateEmail: {
          "#send": {
            [`mailboxIds/${drafts}`]: null,
            [`mailboxIds/${sent}`]: true,
            "keywords/$draft": null,
          },
        },
      },
      "1",
    ],
  ],
);
const refused = written.notCreated?.draft ?? submitted.notCreated?.send;
if (refused) throw new Error(`not sent: ${refused.type} ${refused.description ?? ""}`);
const emailId = written.created.draft.id;
return {
  emailId,
  submissionId: submitted.created.send.id,
  filedInSent: filed?.[0] === "Email/set" && !filed[1].notUpdated?.[emailId],
};
```

- The draft goes into the mailbox whose role is `drafts`. Once it is submitted,
  `onSuccessUpdateEmail` moves it to the one whose role is `sent` and takes its `$draft` keyword
  away; `$seen` keeps that copy from counting as unread.
- `"#draft"` names the message that `Email/set` creates, and `"#send"` the submission, in the same
  request.
- `identityId` is the identity that covers the sender: the same address, or a wildcard `*@domain`
  over it. Find it before you write anything, because a refused submission leaves its draft in
  Drafts.
- The server answers `onSuccessUpdateEmail` with an `Email/set` of its own (`filed`), after the
  submission's response and with its call id. The message is sent either way; it is in Sent unless
  that response's `notUpdated` names it.
- `inReplyTo` and `references` take Message-IDs without their angle brackets. An address may have a
  `name`; `cc` and `bcc` are lists like `to`.
- For HTML, add `html: { value }` to `bodyValues` and `htmlBody: [{ partId: "html", type: "text/html" }]`.
  A message has text, HTML or both.
- An attachment is a blob. `POST` its bytes to the session's `uploadUrl` (on
  `https://api.fastmail.com` too, with `{accountId}` filled in), with the same `authorization` and
  the file's `content-type`. Then add `{ blobId, size, name, type, disposition: "attachment" }` to
  the draft's `attachments`, with `blobId` and `size` from the upload's answer.

### A masked address

```js
// The task: a new address for one site, then switch it off
const [[, made]] = await call(
  [CORE, MASKED_EMAIL],
  [
    [
      "MaskedEmail/set",
      {
        accountId: maskedEmailAccount,
        create: {
          new: { state: "enabled", forDomain: "https://shop.example", description: "one order" },
        },
      },
      "0",
    ],
  ],
);
if (made.notCreated?.new) throw new Error(`not made: ${made.notCreated.new.type}`);
const { id, email } = made.created.new;

// … later, switch it off: its mail goes to the trash
const [[, changed]] = await call(
  [CORE, MASKED_EMAIL],
  [
    [
      "MaskedEmail/set",
      { accountId: maskedEmailAccount, update: { [id]: { state: "disabled" } } },
      "0",
    ],
  ],
);
if (changed.notUpdated?.[id]) throw new Error(`not switched off: ${changed.notUpdated[id].type}`);
return { id, email };
```

- The states: `enabled` delivers. `disabled` sends its mail to the trash. `deleted` bounces it.
  Make a new address `enabled`: it delivers at once and stays until it is deleted. Without a
  `state` it is `pending`, and Fastmail deletes it 24 hours after it is made unless mail arrives
  first.
- `emailPrefix` (at most 64 of a-z, 0-9 and `_`) chooses how the address starts.
- `["MaskedEmail/get", { accountId: maskedEmailAccount }, "0"]` lists every masked address of the
  account, deleted ones included.
- The token needs the Masked Email scope (step 0).
- Fastmail makes masked addresses on the account's own domain when it has one (seen on
  2026-10-06), so they read like ordinary addresses. Its documentation does not say whether mail
  can be sent from one: treat masked addresses as receive-only.

## Mail arriving

The fastest way in is a Fastmail rule that forwards a copy of each message to the project's own
address, `<project>@<its email domain>`, where it lands as an event straight away. The other way is
to poll on a schedule: [Search](#search-and-read) with `after` set to the last time.

## Removing it

Take `jmap()` and its import out of `worker.ts` (and `mail.ts` and the `mailbox()` member, if an
earlier version of this recipe added them), and delete `/secrets/fastmail` (and revoke the token in
Fastmail). The Dash takes nothing away itself, so once that commit is live, take the card off with
its null:
`itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "jmap", card: null } })`.

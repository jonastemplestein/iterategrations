# JMAP

A mailbox for an iterate project over [JMAP](https://jmap.io), the standard (RFC 8620, RFC 8621)
that Fastmail designed and serves natively: send from it, search it, read whole threads. And
Fastmail's [Masked Email](https://www.fastmail.com/for-developers/masked-email/): throwaway
addresses an agent makes for one site and switches off later. It is `fetch` and nothing else, so it
runs in a config worker or any other userspace code.

Mail the project sends goes through the mailbox itself: it is written to Drafts, submitted, and moved
to Sent. So the mailbox holds everything the project sent and received, as a person's mailbox would,
and a person can read it there.

The project never holds the token. It lives in a secret, and iterate's egress swaps it into each
request toward `api.fastmail.com`: the client only ever sends a placeholder naming the secret.

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

## 2. The dependency

In the config repo's `package.json`, pinned to a commit of this repo's `main`:

```json
"iterate-jmap": "https://pkg.pr.new/jonastemplestein/iterategrations/iterate-jmap@<commit>"
```

## 3. Send, search, read

```js
import { connectJmap } from "iterate-jmap";

// itx.fetch, so egress swaps the secret in; Fastmail's session URL and /secrets/fastmail by default
const mail = await connectJmap({ fetch: (input, init) => itx.fetch(new Request(input, init)) });

await mail.send({
  from: "project@your-domain.example", // an address one of the account's identities covers
  to: ["someone@example.com"],
  subject: "Re: the order",
  text: "Thanks, all received.",
  inReplyTo: "<message-id-of-their-mail@example.com>", // threads the reply
});

const recent = await mail.search({ mailbox: "inbox", after: "2026-10-01", limit: 10 });
const thread = await mail.getThread(recent[0].threadId); // oldest first
const full = await mail.getEmail(recent[0].id, { bodies: true }); // text, html, attachments
```

- `send` takes `cc`, `bcc`, `html`, `references` and `attachments` (`{ name, type, data }`), and
  answers `{ emailId, submissionId, filedInSent }`. It refuses a `from` no identity covers, naming
  the identities the account has.
- Every request goes to the session URL's own origin (`sessionOrigin`, default on). Fastmail's
  session names a regional host (`ams.api.fastmail.com`), which also answers on `api.fastmail.com`,
  and a secret is sent only to the exact origins it is pinned to: one pin covers every call.
- Another JMAP server: `connectJmap({ sessionUrl, fetch })`. Another secret:
  `secret: { path, field }`. Outside iterate: `token` (sent as `Bearer <token>`).
- `mail.call(using, methodCalls)` makes any JMAP method calls in one request.
- Every failure is a `JmapError`, naming where (`request`, `Email/set`, …) and the JMAP error type
  (`forbiddenFrom`, `invalidArguments`, …).

## 4. Throwaway addresses (Fastmail Masked Email)

```js
import { connectJmap, maskedEmails } from "iterate-jmap";

const masked = maskedEmails(
  await connectJmap({ fetch: (input, init) => itx.fetch(new Request(input, init)) }),
);
const { id, email } = await masked.create({
  forDomain: "https://shop.example",
  description: "one order",
});
// … later
await masked.setState(id, "disabled"); // its mail goes to the trash
await masked.setState(id, "deleted"); // its mail bounces
const all = await masked.list();
```

- `create` makes the address `enabled`: it delivers at once and stays until it is deleted. With
  `state: "pending"` Fastmail deletes it 24 hours after it is made unless mail arrives first.
- `emailPrefix` (at most 64 of a-z, 0-9 and `_`) chooses how the address starts.
- The token needs the Masked Email scope; without it every call answers `capabilityNotSupported`.
- Not stated in Fastmail's documentation: whether a masked address can be on the account's own
  domain, and whether mail can be sent from one. Treat masked addresses as receive-only.

## 5. Mail arriving

The fastest way in is a Fastmail rule that forwards a copy of each message to the project's own
address, `<project>@<its email domain>`, where it lands as an event straight away. The other way is
to poll: `search({ after: <the last time> })` on a schedule.

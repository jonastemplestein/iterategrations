# Monzo

Every Monzo transaction lands in an iterate mind as a `monzo/transaction-created` event, the
transaction (amount, merchant, category, …) exactly as Monzo sends it, on a stream per account:
`/monzo/<account name>`, with names the person picks (`joint-account`, `jonas-personal`). One
sign-in covers all of a person's accounts, each has its own webhook, and every API tool
(`get_balance`, `list_transactions`, …) works on any of them.

Two halves, both the mind's own, with no server between: **sign in to Monzo** (the mind keeps
Monzo's OAuth sign-in as a secret, and refreshes it), and **register a webhook** with Monzo's API.
Monzo doesn't sign its webhooks, so the recipe puts an unguessable secret in each webhook's URL and
generates it for the person: they never see or type it.

The receiver is the package `iterate-monzo`: one element, `monzo()`, in the `integrations` array of
the mind's config worker. The package also exports `monzoApi`, Monzo's API by tool name for the
mind's agents. It has a page of its own, for the mind's members: the status, the
accounts, and the shape of an account's webhook URL. The mind's Integrations page in the Dash
shows a Monzo card ("Set up by your coding agent" until the sign-in exists), with an **Open** button
to the page and a **Recipe** button to this recipe, and a row per account whose webhook step 4
registered.

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
mind's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 0. Before you start: a Monzo developer client

The person needs a Monzo OAuth client of their own, and it takes a few minutes in Monzo's app.
First get the mind's callback address:

```js
async (itx) => itx.secrets.oauthCallbackUrl();
```

Then tell the person:

1. Open <https://developers.monzo.com/>, sign in with the email Monzo sends, and approve it in the
   Monzo app.
2. **Clients → New OAuth Client:**
   - **Name:** the mind's name
   - **Redirect URL:** the callback address above
   - **Confidentiality: Confidential.** Monzo gives only confidential clients a refresh token.
3. Save. Keep the page open: the next step asks for the **Client ID** and the **Client secret**.
   The secret never goes into a chat.

Make it a client used only for this. Monzo allows one active access token per client per person, so
a second app sharing the client would keep signing this one out.

## 1. Sign in to Monzo

First the client, as one secret that only Monzo's token endpoint may be sent, and that lends its
client secret to the sign-in's refresh:

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/monzo-app",
    egress: { urls: ["https://api.monzo.com"] },
    description:
      "Your Monzo OAuth client, from https://developers.monzo.com/ (Clients): its Client ID and Client secret.",
    fields: [
      { name: "clientId", label: "Client ID", public: true },
      { name: "clientSecret", label: "Client secret" },
    ],
    lendTo: ["/secrets/monzo"], // the sign-in's refresh borrows the client secret
  });
```

Send the person the returned `url`, tell them to paste both values there, and wait until they say
it is saved. Then begin the sign-in. The client ID is public, so the catalog answers it; the client
secret goes in as a placeholder, which the platform fills at the token endpoint:

```js
async (itx) => {
  const app = (await itx.secrets.list()).find((s) => s.path === "/secrets/monzo-app");
  if (!app?.public?.clientId) throw new Error("/secrets/monzo-app has no public clientId yet");
  return itx.secrets.beginOAuth("/secrets/monzo", {
    authorizationEndpoint: "https://auth.monzo.com/",
    tokenEndpoint: "https://api.monzo.com/oauth2/token",
    clientId: app.public.clientId,
    clientSecret: 'getSecret("/secrets/monzo-app", { field: "clientSecret" })',
    clientAuth: "client_secret_post",
    urls: ["https://api.monzo.com"],
  });
};
```

It returns `{ authorizationUrl }`. Send the person the link on a line of its own, and tell them, in
this order:

1. Open the link and press Continue. Monzo asks for their email and mails them a link.
2. Open the mailed link **in the same browser**. The last page says **Done**.
3. Open the Monzo app and approve the prompt to allow access to their data. Until they do, every
   call answers 403.

The link lasts an hour. Then prove the sign-in, read-only:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("https://api.monzo.com/ping/whoami", {
      headers: { authorization: 'Bearer getSecret("/secrets/monzo", { field: "accessToken" })' },
    }),
  );
  return { status: response.status, body: await response.json() }; // authenticated: true
};
```

## 2. Add the receiver to the mind's config repo

Run the script in [add-to-a-mind.md](../add-to-a-mind.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `monzo()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it:

```js
// the values for add-to-a-mind.md
const PACKAGE = "iterate-monzo";
const IMPORT = 'import { monzo, monzoApi } from "iterate-monzo";';
const ELEMENT = "monzo()";
const MEMBER = `  /** Monzo's API by tool name: \`await itx.config.monzoApi("get_balance", { account_id })\`. */
  async monzoApi(tool: string, args: Record<string, unknown> = {}) {
    using itx = this.getItx();
    return await monzoApi(itx, tool, args);
  }`;
const FILES = {};
```

`monzo()` answers the mind's `monzo` host: the worker hands it every request there, and every
event. `/webhook/<account name>/<secret>` takes Monzo's deliveries. The page at `/` is for the
mind's members: it shows the status (whether the sign-in exists), the accounts whose webhook
secret exists, and the shape of an account's webhook URL, with a **Copy** button. It never shows a
secret. Its install hook (`mind/worker-updated`) puts the Monzo card on the Dash. The member gives
every agent `itx.config.monzoApi(tool, args)`: [what the tools do](#what-the-tools-do).

### By hand, or copy the source

By hand: [add-to-a-mind.md](../add-to-a-mind.md#by-hand), with the import and the element above.
To copy the source instead, read [`src/monzo.ts`](src/monzo.ts), [`src/page.ts`](src/page.ts) and
[`src/api.ts`](src/api.ts) (no other imports) and commit them to `/repos/config` under `monzo/`; the import then reads
`from "./monzo/monzo.ts"`. You own the copy.

### Check it's live

The receiver takes only `POST`, so a `GET` is answered `405`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "monzo", path: "/webhook/nope/nope" });
  const res = await itx.fetch(new Request(url));
  return { url, status: res.status }; // 405 = the receiver is there. 404: not published yet
};
```

## 3. Name the accounts

```js
async (itx) => {
  const { accounts } = await itx.config.monzoApi("list_accounts");
  return accounts.map((a) => ({
    id: a.id,
    type: a.type,
    description: a.description,
    owners: a.owners?.map((o) => o.preferred_name),
    closed: a.closed,
  }));
};
```

Show the person the list and have them pick a **name** for each account they want events from:
lowercase letters, digits and hyphens (`joint-account`, `jonas-personal`). The name is the URL's
first segment and the stream's last: `/monzo/<name>`. A joint account shows up beside the personal
one (`uk_retail_joint`); a business account is `uk_business`.

## 4. Register a webhook per account, with a generated secret in its URL

One script per account does it all: it makes the secret, registers the URL
`…/webhook/<name>/<secret>` with Monzo, stores the secret as `/secrets/monzo-webhook-<name>`, and
lists the account under the Monzo card on the Dash. The receiver checks a delivery's secret with
`itx.secrets.verifyEquals`, and a secret answers only the operations it was made with: the script
stores it with `operations: ["verifyEquals"]`. Without that, the receiver answers 500 to every
delivery. The secret is never returned, so it never reaches the chat. Run it once per account, and
again to rotate: it registers the new webhook first and deletes this mind's earlier ones for that
account last, so there is no time without one.

```js
async (itx) => {
  const name = "<the account's name, e.g. joint-account>";
  const accountId = "<its account id from step 3>";
  const secret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const mine = await itx.url({ routingSlug: "monzo", path: `/webhook/${name}/` });
  const url = await itx.url({ routingSlug: "monzo", path: `/webhook/${name}/${secret}` });
  const { webhooks: earlier } = await itx.config.monzoApi("list_webhooks", {
    account_id: accountId,
  });
  const registered = await itx.config.monzoApi("register_webhook", { account_id: accountId, url });
  try {
    await itx.secrets.set(`/secrets/monzo-webhook-${name}`, secret, {
      urls: ["https://monzo.invalid"], // only ever compared, never sent anywhere
      operations: ["verifyEquals"],
    });
  } catch (error) {
    // the new webhook has no secret to be checked against: take it away again
    await itx.config.monzoApi("delete_webhook", { webhook_id: registered.webhook.id });
    throw error;
  }
  for (const old of earlier.filter((hook) => hook.url.startsWith(mine)))
    await itx.config.monzoApi("delete_webhook", { webhook_id: old.id });
  // the account's row under the Monzo card on the Dash (set semantics: the whole row again)
  await itx.cd("/integrations").append({
    type: "events.iterate.com/integration/connection-configured",
    payload: {
      integration: "monzo",
      connection: name,
      row: { account: name, status: { kind: "ok" }, details: { Account: accountId } },
    },
  });
  return { name, webhook: JSON.parse(JSON.stringify(registered).replaceAll(secret, "<secret>")) };
};
```

Check it: `await itx.secrets.verifyEquals("/secrets/monzo-webhook-<name>", { value: "nope" })`
answers `false`. If it throws "was not made to answer it", the secret was stored without the
operation: run the script again.

Each URL is now a password: anyone who has it can post fake transactions to that account's stream.
It is held by the mind's secret store and by Monzo, and it is in the request log of this one
script. Keep it out of chat. One account's URL cannot write to another's stream: each name has its
own secret. The page lists each account whose secret exists, by name, and never the secret.

## 5. Prove it

Ask the person to make a small transaction on one account (a card payment, or have someone send
them £1), then:

```js
async (itx) => {
  const name = "<the account's name>";
  const { payload } = await itx.cd(`/monzo/${name}`).waitForEvent({
    type: "monzo/transaction-created",
    timeoutMs: 110_000,
  });
  const t = payload.transaction;
  return {
    name,
    id: t.id,
    amount: t.amount,
    currency: t.currency,
    description: t.description,
    merchant: t.merchant?.name,
  };
};
```

If it gives up, end your turn and wait for the person to say they've paid. Monzo shows the
transaction in the app a moment before the webhook fires. Then write the accounts, their names and
how to reach the API (`itx.config.monzoApi`) into the mind's `AGENTS.md`.

## What the tools do

`await itx.config.monzoApi(tool, args)` answers Monzo's JSON, and throws with Monzo's status when
Monzo refuses. Amounts are integers in the currency's minor unit.

| Tool                | Arguments                                                                           | Answers                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`            | none                                                                                | `{ authenticated, client_id, user_id }`                                                                                                                                           |
| `list_accounts`     | none                                                                                | `{ accounts }`, closed ones included                                                                                                                                              |
| `get_balance`       | `account_id`                                                                        | Monzo's balance, with `balance_formatted` and `spend_today_formatted`                                                                                                             |
| `list_pots`         | `current_account_id`                                                                | `{ pots }`                                                                                                                                                                        |
| `list_transactions` | `account_id`, `since?`, `before?`, `limit?` (1 to 50, default 20)                   | `{ transactions }`, each `{ id, created, settled, amount, currency, formatted, description, merchant, category, decline_reason, is_load }`; `since` is a time or a transaction id |
| `get_transaction`   | `transaction_id`                                                                    | `{ transaction }`, Monzo's full record with the merchant                                                                                                                          |
| `list_webhooks`     | `account_id`                                                                        | `{ webhooks }` of this client (each URL holds a secret: never return it)                                                                                                          |
| `register_webhook`  | `account_id`, `url`                                                                 | `{ webhook }`                                                                                                                                                                     |
| `delete_webhook`    | `webhook_id`                                                                        | `{ deleted }`                                                                                                                                                                     |
| `create_receipt`    | Monzo's receipt, with `transaction_id`, `external_id`, `total`, `currency`, `items` | `{ saved, external_id, transaction_id }`                                                                                                                                          |
| `get_receipt`       | `external_id`                                                                       | Monzo's receipt                                                                                                                                                                   |
| `delete_receipt`    | `external_id`                                                                       | `{ deleted }`                                                                                                                                                                     |

Monzo answers transactions only for the last 90 days once five minutes have passed since the
sign-in: an older `since` is refused with `forbidden.verification_required`, which is about the
date, not the sign-in.

## The event

On the stream `/monzo/<account name>`:

```json
{
  "type": "monzo/transaction-created",
  "idempotencyKey": "monzo:tx_0000…",
  "payload": {
    "transactionId": "tx_0000…",
    "transaction": {
      "id": "tx_0000…",
      "account_id": "acc_0000…",
      "amount": -510,
      "currency": "GBP",
      "description": "COFFEE",
      "merchant": {},
      "created": "…"
    }
  }
}
```

- `transaction` is Monzo's `data`, untouched. **`amount` is in the currency's minor unit** (pence),
  negative for money out. Merchant details come as sent; `get_transaction` fetches the full record
  with notes and tags.
- Monzo retries a delivery that doesn't answer `200`, up to five times. A retry is the same event:
  the key is the transaction id.
- Only transactions made after the webhook is registered arrive: nothing is backfilled, and the
  webhook covers the one account it was registered for.
- Monzo asks the person to reconfirm API access in the Monzo app about every 90 days. Until they
  do, the API tools answer 403; a webhook that is already registered keeps delivering. If the
  refresh fails with `invalid_grant`, the sign-in has lapsed: run step 1's `beginOAuth` again.
- A Monzo client sees only the webhooks it registered itself. After a move to a new client, register
  each account's webhook again with step 4; the old client's webhooks can only be deleted with the
  old client's sign-in, or by deleting that client at <https://developers.monzo.com/>.
- To stop an account: call `delete_webhook` (`itx.config.monzoApi`), then
  `itx.secrets.delete("/secrets/monzo-webhook-<name>")`, and take its row off the Dash (which takes
  nothing away itself):
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/connection-configured", payload: { integration: "monzo", connection: "<name>", row: null } })`.
- To remove the package: stop each account, take `monzo()` and its import out of `worker.ts`, and
  once that commit is live take the card off with its null, which takes any row left with it:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "monzo", card: null } })`. Delete the sign-in,
  `/secrets/monzo`, and the client, `/secrets/monzo-app`, with `itx.secrets.delete(…)`, and take the
  `monzoApi` member out of `worker.ts`, unless the mind's agents still use the API tools.

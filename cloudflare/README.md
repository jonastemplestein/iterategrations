# Cloudflare

A mind's own Cloudflare OAuth client, with a **Connect Cloudflare** page of its own. Each person
connected there is a secret of the mind, and the mind's code and agents call Cloudflare's API
as that person, on the one account they picked at consent: Workers, D1, KV, R2, containers, routes
and the rest, as far as the scopes go. The platform refreshes each connection's token: the code only
ever sends a placeholder naming the connection's secret, and iterate's egress swaps the token in.

It is mind code: one element, `cloudflare()`, in the `integrations` array of the mind's config
worker, which hands it the requests on the mind's `cloudflare` routing slug, and every event.

- **The page** (members only, at the mind's `cloudflare` address, `/`): the redirect URI and the
  request that registers an OAuth client with it, a link that collects the client (its ID and its
  secret, on one form of iterate's Dash), a **Connect** button, and the connections with Reconnect
  and Disconnect buttons, each with the Cloudflare account its token reaches.
- **The landing** (the same address, `/connected`, members only): Cloudflare sends the person back
  to iterate's own callback, which stores the tokens in the browser that opened the Connect link
  and then sends them here; the page reads what Cloudflare granted (`itx.secrets.oauthResult`) and
  lists the connection.
- **The Integrations page** (the Dash): a Cloudflare card under "This mind's own". Before anything
  is connected it has no status, and its one button is the next step: **Set up** until the client
  is saved, then **Connect an account**. Once a person is connected it says "Connected" (or how
  many), its button is **Add account**, and each connection has a row: the person's address, a
  green dot, the Cloudflare account their token reaches (by name), **Manage** (the page) and
  **Open** (their profile at Cloudflare). A row goes when its secret goes: Disconnect, or the
  secret deleted on the Dash, and at the latest at the next publish.

The deployment's own Cloudflare client (iterate's, and the one people sign in with) is another thing: it is shared by every mind, and the platform keeps it. This
package is for a client the mind owns, with its own scopes: a deploy of iterate's platform into
the person's account, for one.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
mind's root; never take a secret in chat). The only code to commit is one dependency and one element of
`worker.ts`'s `integrations` array.

### 1. The package, in the config repo

Run the script in [add-to-a-mind.md](../add-to-a-mind.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `cloudflare()` to
the `integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-mind.md
const PACKAGE = "iterate-cloudflare";
const IMPORT = 'import { cloudflare } from "iterate-cloudflare";';
const ELEMENT = "cloudflare()";
const MEMBER = "";
const FILES = {};
```

Every connection is asked for `user-details.read offline_access`, which name the person and bring
a refresh token. Ask what the mind should do and name the scopes for it, from Cloudflare's
[list of scopes](https://developers.cloudflare.com/fundamentals/api/reference/permissions/):
`cloudflare({ scopes: ["workers-scripts.read"] })` asks for more. `DEPLOY_SCOPES`, which the package
exports, is everything a deploy of iterate's platform into the account needs (the Worker, its
routes, D1, KV, R2, the container application and its images, the Artifacts namespace, the account's
state store in the Secrets Store): `cloudflare({ scopes: DEPLOY_SCOPES })`. The tokens may go to
`dash.cloudflare.com` and `api.cloudflare.com`; an origin beyond those goes in `urls`.
`cloudflare({ slug: "cf" })` answers another routing slug.

Check that it is live. The page is for members only, so a `GET` from a script, which signs no one
in, is answered with the sign-in, `401`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "cloudflare", path: "/" });
  const res = await fetch(url);
  return { url, status: res.status }; // 401 = the package is there. 404: not published yet
};
```

### 2. The client, the connection

Open the page (the Dash's Integrations page, the Cloudflare card's button) and follow its three
steps: register an OAuth client on your Cloudflare account with the redirect URI the page shows,
iterate's own callback, `<platform origin>/.secrets/oauth/callback` (the
page gives the request, for an API token with **OAuth Clients Write**; the answer carries the
client's id and its secret once), save both on the Dash's form, and press Connect. Cloudflare asks
which account the person grants access to, and sends them back.

### 3. Check the Integrations page

Before you tell the person it is done, read what the page shows:

```js
async (itx) => {
  const { integrations, connections } = await itx.integrations.list();
  const rows = Object.entries(connections).filter(([key]) => key.startsWith("cloudflare/"));
  return { card: integrations.cloudflare, rows: Object.fromEntries(rows) };
};
```

The **Cloudflare** card says "Connected" (or how many are connected), with a row per connection (the person's address, a green dot, the account's name, **Manage**, **Open**). Before the client is saved it has no status and one button, **Set up**; then **Connect an account**. A row
that the page does not list: publish the config repo again, and the install hook takes it away.

## Use it

A connection is a secret, `/secrets/own-cloudflare-<connection>`, whose placeholder a request to
Cloudflare's API carries in its header; the mind's egress swaps the token in. `listAccounts(itx)`
answers each connection with the account its token reaches, by id, which every API route names:

```ts
import { listAccounts, placeholder } from "iterate-cloudflare";

const [first] = await listAccounts(itx);
const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${first.accounts[0].id}/workers/scripts`,
  { headers: { authorization: `Bearer ${placeholder(first.connection)}` } },
);
```

An agent does the same with plain `fetch` and the placeholder from the Dash's row (the page shows
each connection's secret path).

## What it keeps

Every name starts with `own-cloudflare`, so it never collides with the platform's shared Cloudflare
client, which owns `/secrets/cloudflare-<connection>`:

- `/secrets/own-cloudflare-app`: the client, its ID a public field beside its secret, pinned to
  `dash.cloudflare.com`.
- `/secrets/own-cloudflare-<connection>`: a connection's tokens, pinned to `dash.cloudflare.com`
  and `api.cloudflare.com`, refreshed by the platform with the client.
- The kv: `own-cloudflare/accounts/<connection>` (the person, their id, the scopes, the accounts,
  when), `own-cloudflare/pending/<connection>` (a sign-in in flight and the platform's nonce for it,
  for an hour), and `own-cloudflare/removed/<connection>` (a removal whose row has yet to leave the
  Dash). A client registered with an older version of this package's own `/oauth2/callback` needs
  iterate's callback added.

To remove it: Disconnect each person on the page (each row goes; check it as in step 3), take
`cloudflare()` and its import out of `worker.ts`, and delete `/secrets/own-cloudflare-app`. Once
that commit is live, take the card off with its null, which takes any row left with it:
`itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "cloudflare", card: null } })`.
Check that `(await itx.integrations.list()).integrations.cloudflare` is gone.

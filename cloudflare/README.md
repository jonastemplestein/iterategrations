# Cloudflare

A project's own Cloudflare OAuth client, with a **Connect Cloudflare** page of its own. Each person
connected there is a secret of the project, and the project's code and agents call Cloudflare's API
as that person, on the one account they picked at consent: Workers, D1, KV, R2, containers, routes
and the rest, as far as the scopes go. The platform refreshes each connection's token: the code only
ever sends a placeholder naming the connection's secret, and iterate's egress swaps the token in.

It is project code: one element, `cloudflare()`, in the `integrations` array of the project's config
worker, which hands it the requests on the project's `cloudflare` routing slug, and every event.

- **The page** (members only, at the project's `cloudflare` address, `/`): the redirect URI and the
  request that registers an OAuth client with it, a link that collects the client (its ID and its
  secret, on one form of iterate's Dash), a **Connect** button, and the connections with Reconnect
  and Disconnect buttons, each with the Cloudflare account its token reaches.
- **The callback** (the same address, `/oauth2/callback`, members only): Cloudflare sends the
  person back here from its consent screen, and the page connects them.
- **The Dash:** the project's Integrations page shows a Cloudflare card ("Create an OAuth client
  and paste its secret" until the client is saved, then "Connect an account") and a row per
  connection: the person's address, the account their token reaches, the scopes, and buttons to the
  page and to their profile at Cloudflare. The card changes when the client is saved or deleted: the
  package registers it again on that secret's `events.iterate.com/secret/set` and `secret/deleted`
  facts.

The deployment's own Cloudflare client (iterate's, on the Dash's Connect sheet, and the one people
sign in with) is another thing: it is shared by every project, and the platform keeps it. This
package is for a client the project owns, with its own scopes: a deploy of iterate's platform into
the person's account, for one.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). The only code to commit is one dependency and one element of
`worker.ts`'s `integrations` array.

### 1. The package, in the config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `cloudflare()` to
the `integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-cloudflare";
const IMPORT = 'import { cloudflare } from "iterate-cloudflare";';
const ELEMENT = "cloudflare()";
const MEMBER = "";
const FILES = {};
```

Every connection is asked for `user-details.read offline_access`, which name the person and bring
a refresh token. Ask what the project should do and name the scopes for it, from Cloudflare's
[list of scopes](https://developers.cloudflare.com/fundamentals/api/reference/permissions/):
`cloudflare({ scopes: ["workers-scripts.read"] })` asks for more. `DEPLOY_SCOPES`, which the package
exports, is everything a deploy of iterate's platform into the account needs (the Worker, its
routes, D1, KV, R2, the container application and its images, the Artifacts namespace, the account's
state store in the Secrets Store): `cloudflare({ scopes: DEPLOY_SCOPES })`. The tokens may go to
`dash.cloudflare.com` and `api.cloudflare.com`; an origin beyond those goes in `urls`.
`cloudflare({ slug: "cf" })` answers another routing slug.

Check that it is live. The callback is for members only, so a `GET` from a script, which signs no
one in, is answered with the sign-in, `401`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "cloudflare", path: "/oauth2/callback" });
  const res = await fetch(url);
  return { url, status: res.status }; // 401 = the package is there. 404: not published yet
};
```

### 2. The client, the connection

Open the page (the Dash's Integrations page, the Cloudflare card's button) and follow its three
steps: register an OAuth client on your Cloudflare account with the redirect URI the page shows (the
page gives the request, for an API token with **OAuth Clients Write**; the answer carries the
client's id and its secret once), save both on the Dash's form, and press Connect. Cloudflare asks
which account the person grants access to, and sends them back.

## Use it

A connection is a secret, `/secrets/own-cloudflare-<connection>`, whose placeholder a request to
Cloudflare's API carries in its header; the project's egress swaps the token in. `listAccounts(itx)`
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
  when), `own-cloudflare/pending/<digest>` (a sign-in in flight, for an hour),
  `own-cloudflare/removed/<connection>` (a removal whose row has yet to leave the Dash), and
  `own-cloudflare/redirect-uri` (the one the platform last sent).

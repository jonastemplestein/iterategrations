# X

A mind's own X app, with a **Connect X** page of its own. Each X account connected there is a
secret of the mind, and the mind's code and agents call X's API as that account (read posts,
post, search, bookmarks: what its scopes allow). The platform refreshes each account's token: the
agent only ever sends a placeholder naming the account's secret, and iterate's egress swaps the
token in.

It is mind code: one element, `x()`, in the `integrations` array of the mind's config worker,
which hands it the requests on the mind's `x` routing slug, and every event.

- **The page** (members only, at the mind's `x` address, `/`): the callback URL (iterate's own)
  and the website URL to paste into the app's settings at X, a link that collects the client (its ID and its secret, on one
  form of iterate's Dash), a **Connect** button, and the connected accounts with Reconnect and
  Disconnect buttons.
- **The landing** (the same address, `/connected`, members only): X sends the person back to
  iterate's own callback, which stores the tokens in the browser that opened the Connect link and
  then sends them here; the page reads what X granted (`itx.secrets.oauthResult`) and lists the
  account.
- **The Integrations page** (the Dash): an X card under "This mind's own", with X's mark. Before
  anything is connected it has no status, and its one button is the next step: **Set up** until
  the client is saved, then **Connect an account**. Once an account is connected it says
  "Connected" (or how many), its button is **Add account**, and each account has a row: its
  @username, a green dot, **Manage** (the page) and **Open** (the account on X). A row goes when
  the account's secret goes, however it goes: Disconnect, or the secret deleted on the Dash
  (`secret/deleted`), and at the latest at the next publish.

The deployment's own X app (iterate Cloud's, under the "iterate Cloud" heading of the Integrations
page) is another thing: it is shared
by every mind, and the platform keeps it. This package is for an app the mind owns, with its
own developer account at X and its own scopes.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
mind's root; never take a secret in chat). The only code to commit is one dependency and one element of
`worker.ts`'s `integrations` array.

### 1. The package, in the config repo

Run the script in [add-to-a-mind.md](../add-to-a-mind.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `x()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-mind.md
const PACKAGE = "iterate-x";
const IMPORT = 'import { x } from "iterate-x";';
const ELEMENT = "x()";
const MEMBER = "";
const FILES = {};
```

If `worker.ts` already has a name `x`, import it under another:
`const IMPORT = 'import { x as xApp } from "iterate-x";';` and `const ELEMENT = "xApp()";`.

Every account is asked for `tweet.read users.read offline.access`, which name it and bring its
refresh token. Ask the person what the mind should do (read, post, read bookmarks or DMs) and
name the scopes for it, from X's
[list of scopes](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code):
`x({ scopes: ["tweet.write"] })` asks for more. The tokens may go to `api.x.com`; an API on another
origin goes in `urls`. `x({ slug: "twitter" })` answers another routing slug.

Check that it is live. The page is for members only, so a `GET` from a script, which signs no one
in, is answered with the sign-in, `401`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "x", path: "/" });
  const res = await fetch(url);
  return { url, status: res.status }; // 401 = the package is there. 404: not published yet
};
```

### 2. Send the person to the page

```js
async (itx) => itx.url({ routingSlug: "x", path: "/" });
```

Say: "Open this, sign in, and follow the steps." The page walks them through it (`<address>` is the
mind's `x` address; the page shows each URL with a Copy button):

1. **Set up the app** in X's developer console, <https://console.x.com>: the app's **Settings**,
   **User authentication settings**, **Set up** (or **Edit**):
   - **App permissions:** **Read**, or **Read and write** to post.
   - **Type of App:** **Web App, Automated App or Bot**: a confidential client, which has a Client
     Secret.
   - **Callback URI / Redirect URL:** iterate's own callback, `<platform origin>/.secrets/oauth/callback`
     (`itx.secrets.oauthCallbackUrl()` answers it).
   - **Website URL:** the page's own address, `<address>/`.

   Then, under the app's **Keys and tokens**, **OAuth 2.0 Client ID and Client Secret**: both are
   for step 2. X shows the Client Secret once; if it is lost, regenerate it there.

2. **Save the client** through the page's link: a page of iterate's Dash, made by
   `itx.secrets.collectFromUser`, asks for the client ID and the client secret on one form, and
   keeps them as one secret, `/secrets/own-x-app`, pinned to `api.x.com`. The client ID is a public
   field of that secret: the form shows it as plain text and checks its shape, and the mind
   reads it from its list of secrets. The client secret never passes through the mind's code.
3. **Connect an account**: X asks the account signed in at x.com to authorize the app, then sends
   them back to the page, which shows the account. To connect another account, sign in to X as that
   account, then connect again.

Then write the accounts, their secrets and where the page is into the mind's `AGENTS.md`.

### 3. Check the Integrations page

Before you tell the person it is done, read what the page shows:

```js
async (itx) => {
  const { integrations, connections } = await itx.integrations.list();
  const rows = Object.entries(connections).filter(([key]) => key.startsWith("x/"));
  return { card: integrations.x, rows: Object.fromEntries(rows) };
};
```

The **X** card says "Connected" (or how many are connected), with a row per account (its @username, a green dot, **Manage**, **Open**). Before the client is saved it has no status and one button, **Set up**; then **Connect an account**. A row
that the page does not list: publish the config repo again, and the install hook takes it away.

## What the agent gets

Each account is a secret, `/secrets/own-x-<connection>`, whose `accessToken` the platform refreshes
when X answers 401 (an X access token lasts two hours). Send it as a placeholder in a plain `fetch`:
the mind's egress swaps the token in, and only towards the origins the secret is pinned to. To
read the account itself:

```js
async (itx) => {
  const res = await fetch("https://api.x.com/2/users/me", {
    headers: {
      authorization: 'Bearer getSecret("/secrets/own-x-<connection>", { field: "accessToken" })',
    },
  });
  return (await res.json()).data; // { id, name, username }
};
```

The X API v2 reference, <https://docs.x.com/x-api/introduction>, says what each call takes and which
scope it needs: posts, timelines and search under `/2/tweets` and `/2/users/<id>/…`, bookmarks, likes
and DMs.

Which secret is which account: the page lists them, and so does the kv. The platform names each
account at X's `/2/users/me`, with the new token, before it stores anything: `externalId` is the
account's `data.id` there, and `account` its `@username`. A Reconnect is held to the same account,
so a secret always holds the tokens of the account the kv names.

```js
async (itx) => {
  const { keys } = await itx.kv.list("own-x/accounts/");
  return Promise.all(
    keys.map(async (key) => ({
      secret: `/secrets/own-x-${key.slice("own-x/accounts/".length)}`,
      ...JSON.parse(await itx.kv.get(key)), // { account, externalId, scopes, at }
    })),
  );
};
```

The package exports `placeholder(connection)` (that string) and `secretOf`.

## Good to know

- **The callback URI is iterate's own**, `<platform origin>/.secrets/oauth/callback`, the same for
  every mind on the deployment, so a rename or a claimed hostname changes nothing at X. X refuses
  a callback that is not registered exactly, to the trailing slash. iterate completes a sign-in only
  in the browser that opened the Connect link, and only for a member; the page never receives a
  code. An app registered with an older version of this package's own `/oauth2/callback` needs
  iterate's callback added.
- **The app must be a confidential client.** Only a Web App, Automated App or Bot has a Client
  Secret, which the platform sends to X's token endpoint in a Basic header at the exchange and at
  every refresh. A Native App or a Single Page App is a public client, which this page does not
  use.
- **One client serves every account.** The client is one secret, `/secrets/own-x-app`: its
  `clientId`, a public field that the catalog (`itx.secrets.list()`) answers, and its
  `clientSecret`. The package keeps no copy of the ID. A secret there without the public `clientId`
  (set by hand, or saved by an older version of this package) is not a client: the page says so,
  and asks to save the client again. Each account's secret holds the client ID and a placeholder
  for the client secret, `getSecret("/secrets/own-x-app", { field: "clientSecret" })`, which the
  platform reads at each refresh. To rotate the secret, regenerate it at X and save the client
  again through the page's link (**Replace it**: the form asks for the ID and the new secret) right
  away.
- **A row per account.** X's token answer names no account (X has no ID token), so the platform
  names each account at X's `/2/users/me`, with the new token, before it stores anything (`account`
  in `beginOAuth`), and the page keeps what it answers. The same account connected again replaces
  its older connection: that secret goes, and its row.
- **Reconnect** asks X again on the same connection: for more scopes, or when the refresh token has
  stopped working. Sign in to X as the same account first. It is held to the same account: the
  platform refuses another account's tokens before it stores them (`expectAccount`, against the id
  `/2/users/me` names), the page shows the refusal, and the account keeps its old tokens. A change
  to `scopes` or `urls` reaches an account at its next Reconnect: its grant and its pin are set when
  it connects.
- **Refresh tokens rotate.** X issues a refresh token only for `offline.access`, and can answer a
  refresh with a new one: the platform keeps the newest.
- **Disconnect** deletes the account's secret, then forgets it here. A secret that cannot be deleted
  is shown as an error, and the account stays listed, so Disconnect again can finish. A row the Dash
  could not be told to take away is taken away by Disconnect again, or at the next publish: until
  then `own-x/removed/<connection>` in the kv marks it. Check the page after it: the account's row
  is gone (`itx.integrations.list()`, as in step 3). The app stays authorized at X until the
  account revokes it, in X's settings under **Security and account access**, **Apps and sessions**,
  **Connected apps**.
- **Removing it.** Disconnect each account on the page, take `x()` and its import out of `worker.ts`,
  and delete `/secrets/own-x-app`. Once that commit is live, take the card off with its null, which
  takes any row left with it:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "x", card: null } })`.
  Check that `(await itx.integrations.list()).integrations.x` is gone.
  Then delete the app at X, or keep it for another mind.
- **Its own names.** Everything the package keeps starts with `own-x`: the secrets
  `/secrets/own-x-app` and `/secrets/own-x-<connection>`, and the kv keys `own-x/…`. iterate's
  shared X app owns every `/secrets/x-<connection>` and `/integrations/x/<connection>`, for any
  connection name a member or an agent chooses, so a mind can use both. The routing slug and the
  card on the Dash stay `x`.

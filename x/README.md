# X

A project's own X app, with a **Connect X** page of its own. Each X account connected there is a
secret of the project, and the project's code and agents call X's API as that account (read posts,
post, search, bookmarks: what its scopes allow). The platform refreshes each account's token: the
agent only ever sends a placeholder naming the account's secret, and iterate's egress swaps the
token in.

It is project code: one element, `x()`, in the `integrations` array of the project's config worker,
which hands it the requests on the project's `x` routing slug, and every event.

- **The page** (members only, at the project's `x` address, `/`): the callback and website URLs to
  paste into the app's settings at X, a form for the client ID, a link that collects the client
  secret, a **Connect** button, and the connected accounts with Reconnect and Disconnect buttons.
- **The callback** (the same address, `/oauth2/callback`, members only): X sends the person back
  here from its authorization page, and the page connects the account.
- **The Dash:** the project's Integrations page shows an X card ("Create an OAuth client and paste
  its secret" until the app is set up, then "Connect an account") and a row per account: its
  @username, its scopes, and buttons to the page and to the account on X.

The deployment's own X app (iterate's, on the Dash's Connect sheet) is another thing: it is shared
by every project, and the platform keeps it. This package is for an app the project owns, with its
own developer account at X and its own scopes.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). The only code to commit is one dependency and one element of
`worker.ts`'s `integrations` array.

### 1. The package, in the config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `x()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-x";
const IMPORT = 'import { x } from "iterate-x";';
const ELEMENT = "x()";
const MEMBER = "";
const FILES = {};
```

If `worker.ts` already has a name `x`, import it under another:
`const IMPORT = 'import { x as xApp } from "iterate-x";';` and `const ELEMENT = "xApp()";`.

Every account is asked for `tweet.read users.read offline.access`, which name it and bring its
refresh token. Ask the person what the project should do (read, post, read bookmarks or DMs) and
name the scopes for it, from X's
[list of scopes](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code):
`x({ scopes: ["tweet.write"] })` asks for more. The tokens may go to `api.x.com`; an API on another
origin goes in `urls`. `x({ slug: "twitter" })` answers another routing slug.

Check that it is live. The callback is for members only, so a `GET` from a script, which signs no
one in, is answered with the sign-in, `401`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "x", path: "/oauth2/callback" });
  const res = await fetch(url);
  return { url, status: res.status }; // 401 = the package is there. 404: not published yet
};
```

### 2. Send the person to the page

```js
async (itx) => itx.url({ routingSlug: "x", path: "/" });
```

Say: "Open this, sign in, and follow the steps." The page walks them through it (`<address>` is the
project's `x` address; the page shows each URL with a Copy button):

1. **Set up the app** in X's developer console, <https://console.x.com>: the app's **Settings**,
   **User authentication settings**, **Set up** (or **Edit**):
   - **App permissions:** **Read**, or **Read and write** to post.
   - **Type of App:** **Web App, Automated App or Bot**: a confidential client, which has a Client
     Secret.
   - **Callback URI / Redirect URL:** `<address>/oauth2/callback`.
   - **Website URL:** the page's own address, `<address>/`.

   Then, under the app's **Keys and tokens**, **OAuth 2.0 Client ID and Client Secret**: the Client
   ID for step 2 and the Client Secret for step 3. X shows the Client Secret once; if it is lost,
   regenerate it there.

2. **Paste the client ID** on the page (public, kept in the project's kv).
3. **Save the client secret** through the page's link: a page of iterate's Dash, made by
   `itx.secrets.collectFromUser`, keeps it as `/secrets/own-x-app`, pinned to `api.x.com`. It never
   passes through the project's code.
4. **Connect an account**: X asks the account signed in at x.com to authorize the app, then sends
   them back to the page, which shows the account. To connect another account, sign in to X as that
   account, then connect again.

Then write the accounts, their secrets and where the page is into the project's `AGENTS.md`.

## What the agent gets

Each account is a secret, `/secrets/own-x-<connection>`, whose `accessToken` the platform refreshes
when X answers 401 (an X access token lasts two hours). Send it as a placeholder in a plain `fetch`:
the project's egress swaps the token in, and only towards the origins the secret is pinned to. To
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

Which secret is which account: the page lists them, and so does the kv.

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

- **The callback URI is the project's address under iterate's ingress**, `x--<project>.<…>`, never a
  primary hostname: the platform composes it, and sends it to X with each Connect. A rename of the
  project moves it, and the app's settings at X must follow. X refuses a callback that is not
  registered exactly, to the trailing slash. A project with a primary hostname serves the page there,
  under another address: after its first Connect, the page also shows the URI the platform sent, to
  add to the app.
- **The app must be a confidential client.** Only a Web App, Automated App or Bot has a Client
  Secret, which the platform sends to X's token endpoint in a Basic header at the exchange and at
  every refresh. A Native App or a Single Page App is a public client, which this page does not
  use.
- **One client secret serves every account.** Each account's secret holds the client ID and a
  placeholder for the client secret, `getSecret("/secrets/own-x-app", { field: "clientSecret" })`,
  which the platform reads at each refresh. To rotate it, regenerate it at X and save the new one
  through the page's link (**Replace it**) right away.
- **A row per account.** The page names each account with one call to X's `/2/users/me`, through
  the project's egress, right after the platform has stored its tokens. The same account connected
  again replaces its older connection: that secret goes, and its row.
- **Reconnect** asks X again on the same connection: for more scopes, or when the refresh token has
  stopped working. Sign in to X as the same account first. X's token answer names no account (X has
  no ID token), so the platform cannot hold a reconnect to the account (`expectAccount` would refuse
  every one). The page checks the account itself, once the tokens are stored: if X signed another
  account in, or `/2/users/me` does not answer, it deletes those tokens, and the connection with
  them, since they replaced the old ones. A change to `scopes` or `urls` reaches an account at its
  next Reconnect: its grant and its pin are set when it connects.
- **Refresh tokens rotate.** X issues a refresh token only for `offline.access`, and can answer a
  refresh with a new one: the platform keeps the newest.
- **Disconnect** deletes the account's secret, then forgets it here. A secret that cannot be deleted
  is shown as an error, and the account stays listed, so Disconnect again can finish. A row the Dash
  could not be told to take away is taken away by Disconnect again, or at the next publish: until
  then `own-x/removed/<connection>` in the kv marks it. The app stays authorized at X until the
  account revokes it, in X's settings under **Security and account access**, **Apps and sessions**,
  **Connected apps**.
- **Removing it.** Disconnect each account on the page, take `x()` and its import out of `worker.ts`,
  and delete `/secrets/own-x-app`. Once that commit is live, take the card off with its null, which
  takes any row left with it:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "x", card: null } })`.
  Then delete the app at X, or keep it for another project.
- **Its own names.** Everything the package keeps starts with `own-x`: the secrets
  `/secrets/own-x-app` and `/secrets/own-x-<connection>`, and the kv keys `own-x/…`. iterate's
  shared X app owns every `/secrets/x-<connection>` and `/integrations/x/<connection>`, for any
  connection name a member or an agent chooses, so a project can use both. The routing slug and the
  card on the Dash stay `x`.

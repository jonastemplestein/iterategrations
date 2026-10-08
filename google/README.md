# Google

A project's own Google OAuth client, with a **Connect Google** page of its own. Each Google account
connected there is a secret of the project, and the project's code and agents call Google's APIs
(Gmail, Calendar, Drive and the rest) as that account. The platform refreshes each account's token:
the agent only ever sends a placeholder naming the account's secret, and iterate's egress swaps the
token in.

It is project code: one element, `google()`, in the `integrations` array of the project's config
worker, which hands it the requests on the project's `google` routing slug, and every event.

- **The page** (members only, at the project's `google` address, `/`): the redirect URI to paste
  into the OAuth client at Google, a link that collects the client (its ID and its secret, on one
  form of iterate's Dash), a **Connect** button, and the connected accounts with Reconnect and
  Disconnect buttons.
- **The callback** (the same address, `/oauth2/callback`, members only): Google sends the person
  back here from its consent screen, and the page connects the account.
- **The Dash:** the project's Integrations page shows a Google card ("Create an OAuth client and
  paste its secret" until the client is saved, then "Connect an account") and a row per account:
  its address, its scopes, and buttons to the page and to the account's third-party access at
  Google. The card changes when the client is saved or deleted: the package registers it again on
  that secret's `events.iterate.com/secret/set` and `secret/deleted` facts.

The deployment's own Google client (iterate's, on the Dash's Connect sheet) is another thing: it is
shared by every project, and the platform keeps it. This package is for a client the project owns,
with its own consent screen and its own scopes.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). The only code to commit is one dependency and one element of
`worker.ts`'s `integrations` array.

### 1. The package, in the config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `google()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-google";
const IMPORT = 'import { google } from "iterate-google";';
const ELEMENT = "google()";
const MEMBER = "";
const FILES = {};
```

Every account is asked for `openid email profile`, which name it. Ask the person what the project
should do (read mail, see the calendar, edit a sheet) and name the scopes for it, from Google's
[list of scopes](https://developers.google.com/identity/protocols/oauth2/scopes):
`google({ scopes: ["https://www.googleapis.com/auth/gmail.readonly"] })` asks for more. The tokens
may go to `oauth2.googleapis.com`, `www.googleapis.com` (Calendar, Drive) and
`gmail.googleapis.com`; an API on another origin goes in `urls`:
`google({ scopes: ["https://www.googleapis.com/auth/spreadsheets"], urls: ["https://sheets.googleapis.com"] })`.
`google({ slug: "gmail" })` answers another routing slug.

Check that it is live. The callback is for members only, so a `GET` from a script, which signs no
one in, is answered with the sign-in, `401`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "google", path: "/oauth2/callback" });
  const res = await fetch(url);
  return { url, status: res.status }; // 401 = the package is there. 404: not published yet
};
```

### 2. Send the person to the page

```js
async (itx) => itx.url({ routingSlug: "google", path: "/" });
```

Say: "Open this, sign in, and follow the steps." The page walks them through it:

1. **Create the OAuth client** at <https://console.cloud.google.com/apis/credentials>, in a Google
   Cloud project of their own: **Create credentials**, **OAuth client ID**, type **Web
   application**, with `<address>/oauth2/callback` under **Authorized redirect URIs** (`<address>`
   is the project's `google` address; the page shows the URI with a Copy button). Google asks for
   the **OAuth consent screen** before the first client. While its publishing status is
   **Testing**, only its test users can connect: add each account as a test user, or publish the
   app. Then enable each API the scopes need (the Gmail API, …) under **APIs & Services**,
   **Library**.
2. **Save the client** through the page's link: a page of iterate's Dash, made by
   `itx.secrets.collectFromUser`, asks for the client ID and the client secret on one form, and
   keeps them as one secret, `/secrets/own-google-app`, pinned to `oauth2.googleapis.com`. The
   client ID is a public field of that secret: the form shows it as plain text and checks its shape
   (it ends in `.apps.googleusercontent.com`), and the project reads it from its list of secrets.
   The client secret never passes through the project's code.
3. **Connect an account**: Google asks which account, and for its consent, then sends them back to
   the page, which shows the account. Connect again for each other account.

Then write the accounts, their secrets and where the page is into the project's `AGENTS.md`.

## What the agent gets

Each account is a secret, `/secrets/own-google-<connection>`, whose `accessToken` the platform
refreshes when Google answers 401 (a Google access token lasts an hour). Send it as a placeholder in
a plain `fetch`: the project's egress swaps the token in, and only towards the origins the secret is
pinned to. To list Gmail messages (with the `gmail.readonly` scope, and the Gmail API enabled):

```js
async (itx) => {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10", {
    headers: {
      authorization:
        'Bearer getSecret("/secrets/own-google-<connection>", { field: "accessToken" })',
    },
  });
  return (await res.json()).messages; // [{ id, threadId }, …]
};
```

Google's API references say what each call takes and which scope it needs: Gmail at
<https://developers.google.com/gmail/api/reference/rest>, Calendar at
<https://developers.google.com/calendar/api/v3/reference>, Drive at
<https://developers.google.com/drive/api/reference/rest/v3>.

Which secret is which account: the page lists them, and so does the kv. The platform names each
account at Google's userinfo endpoint, with the new token, before it stores anything: `externalId`
is the account's `id` there, and `account` its `email`. A Reconnect is held to the same account, so
a secret always holds the tokens of the account the kv names.

```js
async (itx) => {
  const { keys } = await itx.kv.list("own-google/accounts/");
  return Promise.all(
    keys.map(async (key) => ({
      secret: `/secrets/own-google-${key.slice("own-google/accounts/".length)}`,
      ...JSON.parse(await itx.kv.get(key)), // { account, externalId, scopes, at }
    })),
  );
};
```

The package exports `placeholder(connection)` (that string) and `secretOf`.

## Good to know

- **The platform composes the redirect URI** and sends it to Google with each Connect: on the
  hostname the deployment's config pins to the project when it has one (then it is the page's own
  address), else the project's address under iterate's ingress, `google--<project>.<…>`; never a
  hostname the project claimed on the Dash. A rename of the project moves the ingress form, and the
  client at Google must follow. Google refuses a redirect URI that is not registered exactly
  (`redirect_uri_mismatch`). A project that claimed a primary hostname serves the page there, under
  another address: after its first Connect, the page also shows the URI the platform sent, to add to
  the client.
- **One client serves every account.** The client is one secret, `/secrets/own-google-app`: its
  `clientId`, a public field that the catalog (`itx.secrets.list()`) answers, and its
  `clientSecret`. The package keeps no copy of the ID. A secret there without the public `clientId`
  (set by hand, or saved by an older version of this package) is not a client: the page says so,
  and asks to save the client again. Each account's secret holds the client ID and a placeholder
  for the client secret, `getSecret("/secrets/own-google-app", { field: "clientSecret" })`, which
  the platform reads at each refresh. To rotate the secret, add a new one on the client's page at
  Google, save the client again through the page's link (**Replace it**: the form asks for the ID
  and the new secret), then delete the old secret at Google. To move to another client, save it
  through the same link, then Reconnect each account.
- **A row per account.** The platform names each account at Google's userinfo endpoint, with the new
  token, before it stores anything (`account` in `beginOAuth`), and the page keeps what it answers.
  The same account connected again replaces its older connection: that secret goes, and its row.
- **Reconnect** asks Google again on the same connection: for more scopes, or when the refresh token
  has stopped working. It is held to the same account: the platform refuses another account's tokens
  before it stores them (`expectAccount`, against the id the userinfo endpoint names), the page
  shows the refusal, and the account keeps its old tokens. Google is hinted to ask for that account
  (`login_hint`). A change to `scopes` or `urls` reaches an account at its next Reconnect: its grant
  and its pin are set when it connects.
- **Testing lasts 7 days.** While the consent screen's publishing status is **Testing**, a refresh
  token for more than an account's name and address lapses after 7 days, and the account needs a
  Reconnect. Publish the app, or make it **Internal** for a Google Workspace organization's own
  accounts. Google issues a refresh token only with offline access and the consent screen, which the
  page asks for each time.
- **Disconnect** deletes the account's secret, then forgets it here. A secret that cannot be deleted
  is shown as an error, and the account stays listed, so Disconnect again can finish. A row the Dash
  could not be told to take away is taken away by Disconnect again, or at the next publish: until
  then `own-google/removed/<connection>` in the kv marks it. The access stays granted at Google until
  the account removes it at <https://myaccount.google.com/permissions>.
- **Removing it.** Disconnect each account on the page, take `google()` and its import out of
  `worker.ts`, and delete `/secrets/own-google-app`. Once that commit is live, take the card off with
  its null, which takes any row left with it:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "google", card: null } })`.
  Then delete the client at Google, or keep it for another project.
- **Its own names.** Everything the package keeps starts with `own-google`: the secrets
  `/secrets/own-google-app` and `/secrets/own-google-<connection>`, and the kv keys `own-google/…`.
  iterate's shared Google client owns every `/secrets/google-<connection>` and
  `/integrations/google/<connection>`, for any connection name a member or an agent chooses, so a
  project can use both. The routing slug and the card on the Dash stay `google`.

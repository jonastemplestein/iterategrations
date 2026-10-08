# GitHub

A project's own GitHub App, with a **Connect GitHub** page of its own. GitHub's webhook deliveries for
each installation land in the project as events, and the project's code and agents call GitHub's API
as the installation. The platform mints each installation's token from the App's key: the agent only
ever sends a placeholder naming the installation's secret, and iterate's egress swaps the token in.

It is project code: one element, `github()`, in the `integrations` array of the project's config
worker, which hands it the requests on the project's `github` routing slug, and every event.

- **The page** (members only, at the project's `github` address, `/`): the URLs to paste into the
  App's settings, a form for the App's ID and slug, a link that collects its private key and webhook
  secret, an **Install** button, and the installations with a Disconnect button.
- **The setup URL** (the same address, `/oauth2/callback`, members only): GitHub sends the person back here
  after an install, and the page connects the installation.
- **The webhook** (the same address, `/webhook`): GitHub's, checked with the App's webhook secret.
- **The Dash:** the project's Integrations page shows a GitHub card ("Create a GitHub App and paste
  its secrets" until the App is set up) and a row per installation: its account, and buttons to the
  page and to the account on GitHub.

The deployment's own GitHub App (iterate's, on the Dash's Connect sheet) is another thing: it is
shared by every project, and the platform keeps it. This package is for an App the project owns.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). The only code to commit is one dependency and one element of
`worker.ts`'s `integrations` array.

### 1. The package, in the config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `github()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-github";
const IMPORT = 'import { github } from "iterate-github";';
const ELEMENT = "github()";
const MEMBER = "";
const FILES = {};
```

`github({ slug: "gh" })` answers another routing slug. Check that it is live. The webhook takes only
`POST`, so a `GET` is answered `405`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "github", path: "/webhook" });
  const res = await itx.fetch(new Request(url));
  return { url, status: res.status }; // 405 = the package is there. 404: not published yet
};
```

### 2. Send the person to the page

```js
async (itx) => itx.url({ routingSlug: "github", path: "/" });
```

Say: "Open this, sign in, and follow the steps." The page walks them through it:

1. **Create the App** at <https://github.com/settings/apps/new>, or for an organization at
   `https://github.com/organizations/<org>/settings/apps/new`, with (`<address>` is the project's
   `github` address, `itx.url({ routingSlug: "github" })`):
   - **Homepage URL:** the page's own address.
   - **Setup URL:** `<address>/oauth2/callback`, with **Redirect on update** ticked.
   - **Webhook URL:** `<address>/webhook`, and a **webhook secret** they make up
     (`openssl rand -hex 32`).
   - **Permissions** and **events:** what the project needs, and no more. Ask the person what the
     project should do (read code, comment on issues, review pull requests) and name the permissions
     for it.
   - **Where can this GitHub App be installed?** "Only on this account", unless other accounts
     should install it.

   The page shows each URL with a Copy button. Then they press **Generate a private key**, and
   GitHub downloads a `.pem` file.

2. **Paste the App ID and slug** on the page (both public, kept in the project's kv). The slug is
   the end of the App's public link, `https://github.com/apps/<slug>`; the link itself works too.
3. **Save the private key and the webhook secret** through the page's link: a page of iterate's
   Dash, made by `itx.secrets.collectFromUser`, keeps them as `/secrets/own-github-app`, pinned to
   `github.com` and `api.github.com`. They never pass through the project's code.
4. **Install**: GitHub asks which account and which repositories, then sends them back to the page,
   which connects the installation and shows its account.

Then write the App's name, its installations and where its page is into the project's `AGENTS.md`.

## What the agent gets

For each delivery, one `github/delivery-received` on
`/integrations/own-github/<installation id>`, keyed by GitHub's delivery id, so a redelivery adds
nothing:

```json
{
  "type": "github/delivery-received",
  "idempotencyKey": "github:<installation id>:<X-GitHub-Delivery>",
  "payload": {
    "installationId": "<installation id>",
    "delivery": { "id": "<X-GitHub-Delivery>", "name": "<X-GitHub-Event: issues, push, …>" },
    "body": {}
  }
}
```

`body` is GitHub's payload, untouched. A project's worker routes it in `processEvent` (an issue
opened, a review asked for) to its agents.

Each installation is a secret, `/secrets/own-github-<installation id>`, whose `accessToken` the
platform mints from the App's key on first use and again when GitHub answers 401. Call the API with
its placeholder:

```js
async (itx) => {
  const res = await itx.fetch(
    new Request("https://api.github.com/installation/repositories", {
      headers: {
        authorization:
          'Bearer getSecret("/secrets/own-github-<installation id>", { field: "accessToken" })',
        accept: "application/vnd.github+json",
        "user-agent": "iterate",
      },
    }),
  );
  return (await res.json()).repositories.map((repository) => repository.full_name);
};
```

In the config repo's code, Octokit takes the same placeholder, with `itx.fetch` as its fetch:

```ts
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({
  auth: 'getSecret("/secrets/own-github-<installation id>", { field: "accessToken" })',
  userAgent: "iterate",
  request: { fetch: (url: string, init: RequestInit) => itx.fetch(new Request(url, init)) },
});
```

The package exports `placeholder(installationId)` (that string), `secretOf` and `streamOf`.

## Good to know

- **The URLs are on the project's host.** Renaming the project moves its hosts, and GitHub keeps
  pointing at the old ones. Set a primary hostname for the project before you create an App that
  should outlive a rename, and paste the URLs the page shows on it.
- **One App secret serves every installation.** An installation's secret holds the App ID and a
  placeholder for the key, `getSecret("/secrets/own-github-app", { field: "privateKey" })`, which
  the platform reads at each mint. To rotate the key, generate a new one at GitHub, save it through
  the page's link (**Replace them**), then delete the old one at GitHub.
- **No admin proof.** iterate's shared App proves that the person administers an account before an
  installation counts for a project. This App is the project's own: it holds the App's key, so it
  can mint for any installation of its App already. The page binds GitHub's redirect to an install
  it started instead: a nonce in the install link's `state`, good for an hour (or, for a request,
  until it is answered). An installation claims its nonce once, as an `own-github/nonce-used`
  event on `/integrations/own-github` keyed by the nonce, before any secret is written, so two
  redirects with one nonce never both go on.
- **An update proves itself first.** GitHub sends the person back after every change to an
  installation. The page proves it through a secret of its own,
  `/secrets/own-github-<id>-proof`, and changes the installation's secret only once the proof has
  passed, so a failure at GitHub, or a wrong App ID saved on the page, leaves a working
  installation as it was. The proof's secret goes either way.
- **The first ping fails.** GitHub sends a `ping` when the App is created, before its webhook
  secret is saved here, so it is refused. Redeliver it from the App's **Advanced** tab once the
  secrets are saved, if you want to see one go through. A delivery for an installation the page did
  not connect is acknowledged and dropped.
- **An installation an owner must approve.** When the person installs on an organization they do not
  own, GitHub asks an owner, and the page shows a request waiting, which keeps its nonce. When GitHub
  comes back with that nonce, once the owner has approved, the request becomes the installation; any
  other request keeps waiting. If GitHub does not come back with it, press **Install** again and
  **Save** on GitHub's page, then **Forget** the request.
- **Disconnect** deletes the installation's secret, then forgets it here. A secret that cannot be
  deleted is shown as an error, and the installation stays listed, so Disconnect again can finish.
  The Dash only shows what the package registered and takes nothing away itself, so a row goes only
  when the package appends its null. A row the Dash could not be told to take away is taken away by
  Disconnect again, or at the next publish: until then `own-github/removed/<connection>` in the kv
  marks it. The App stays installed at GitHub: only its account can uninstall it.
- **Removing it.** Disconnect each installation and Forget each request on the page, take
  `github()` and its import out of `worker.ts`, and delete `/secrets/own-github-app`. Once that
  commit is live, take the card off with its null, which takes any row left with it:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "github", card: null } })`. Then delete the App
  at GitHub, or keep it for another project.
- **Its own names.** Everything the package keeps starts with `own-github`: the secrets
  `/secrets/own-github-app` and `/secrets/own-github-<installation id>`, the streams
  `/integrations/own-github/<installation id>`, and the kv keys `own-github/…`. iterate's shared
  GitHub App owns every `/secrets/github-<connection>` and `/integrations/github/<connection>`, for
  any connection name a member or an agent chooses (`app`, digits), so a project can use both. The
  routing slug and the card on the Dash stay `github`.
- **Not the platform's event.** `events.iterate.com/github/webhook-received` is the platform's record
  of a delivery for iterate's shared App (github-sync and the AI linter read it). This package's
  event is its own, `github/delivery-received`.

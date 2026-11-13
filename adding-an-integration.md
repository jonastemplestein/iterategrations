# Adding an integration to iterate

An integration is a package a mind hosts in its own config worker. The platform knows nothing of
the service: the package serves its own pages and webhooks on the mind's host, keeps its
credentials through `itx.secrets`, and tells the Dash about itself. This guide says how to write one,
how to test it, and how to publish it so a coding agent can add it to any mind from its README.
Each package here is a folder of its own; [add-to-a-mind.md](add-to-a-mind.md) is the one
script that adds any of them.

## The shape

A package exports one function that returns an `Integration` (`iterate/sdk`):

```ts
import type { Integration } from "iterate/sdk";

export function acme(options: { slug?: string } = {}): Integration {
  const routingSlug = options.slug ?? "acme";
  return {
    // the host it answers: acme--<mind>.<ingress>, or <origin>/minds/<mind>/acme/ under paths
    routingSlug,
    // every request on that host and no other: deliveries at /webhook, which prove themselves,
    // then for members only the landing after a sign-in at /connected and the page at /
    async fetch(request, host) {
      const url = new URL(request.url);
      if (url.pathname === "/webhook") return receive(request, host.getItx());
      const denied = host.auth.require(request);
      if (denied) return denied;
      using itx = host.getItx();
      if (url.pathname === "/connected") return landing(request, itx);
      return page(request, itx, routingSlug);
    },
    // every durable event of the mind, unordered, at least once
    async processEvent({ event, itx }) {
      if (event.type === "events.iterate.com/mind/worker-updated")
        await register(itx, routingSlug, `${event.path}@${event.offset}`);
    },
  };
}
```

A package's address has three places and no others. `/` is its page, for members. `/connected` is
where iterate sends the member back after a sign-in at a provider, for members too. `/webhook` takes a service's deliveries,
which prove themselves (`/webhook/<name>` when a service has several). Those are the URLs a person
registers at the service.

The mind's `worker.ts` lists it: `const integrations: Integration[] = [acme()];`. The worker hands
each element the requests on its routing slug and every event, after the mind's own cases. A hook
returns for an event it does not handle: one that throws fails that event for the whole worker, which
the platform retries. Every reaction is an append keyed by the event's path and offset, so a retry
lands nothing twice.

What a package has: `host.getItx()` is the mind's scope (`itx.secrets`, `itx.kv`, `itx.cd(path)`,
`itx.schedules`); `host.auth.require(request)` is the member gate. What it never has: a raw secret. A
credential is set through `collectFromUser` or OAuth, pinned to the hosts it may go to, and spent as a
`getSecret("/secrets/<name>", { field })` placeholder in an outbound request, which egress
substitutes. In every worker the platform loads the global `fetch` is the mind's egress, so a
package, a run script and an agent all call a service with plain `fetch`. A package ships no client
for agents: a run script cannot import a package, so the README gives the secret's placeholder, the
pinned origins and the service's own HTTP docs. For the mind's own code, a package exports small
helpers, as few as that code needs, built on a public package when a good one exists: iterate-jmap's
`mailbox()` on jmap-jam is the example. The platform installs a package's tarball and none of its
dependencies, so the build compiles that public package in (`deps.onlyBundle`, and
`deps.onlyImport: []` to fail the build on any import). The rest of a package's code is what the
service pushes (webhooks), what a person does (the page) and what the platform cannot do.

## Keep the Integrations page true

The Dash's Integrations page draws what the mind's packages registered on the `/integrations`
context. It changes nothing itself and has no expiry. So a package must say what is true, and take
back what is no longer true. The contract is `core/lib/src/integrations.ts` in
[iterate/core](https://github.com/iterate/core) (`iterate/integrations` in a mind).

**The contract in brief.**

- A **card** (`integration/configured`) is the integration: `title`, a `description` of one
  sentence (the page shows it whole, at most 400 characters), an `icon`, a `status`, and at most
  four `actions`. Its key is the integration's name, a routing slug's shape.
- A **row** (`integration/connection-configured`) is one connection under its card: an `account`
  (what the provider calls it), a `status`, at most four `actions`, and `details`. Its key is
  `<integration>/<connection>`. A row stands only under a card that exists.
- A card may name another card as its `section`. The named card is then drawn as a heading (its
  icon, title, description) above the cards that name it. A card with no section stands under
  "This mind's own".
- An `icon` is an https URL, or a place in the mind, `{ routingSlug?, path }`: a file that the
  package serves on its own routing slug. Do not point at another app's files (the template
  Dash's `/brands/` marks exist only on a mind whose Dash is the template's).
- A `status` is `{ kind: "ok" | "attention" | "error", text? }`, drawn as a coloured dot and plain
  words. `{ kind: "ok" }` with no text is only a dot on a row, and "OK" on a card. The card's header
  shows the worst status of the card and its rows.
- An action is a link: `{ label, url }`, or `{ label, routingSlug, path }`, a place in the mind
  whose URL the Dash makes. Only buttons look pressable. A card with no status and no row draws
  its first button dark: the one thing to do.
- Both are set semantics: append the whole card or row again when anything changes. A `null` card
  takes the card and all its rows away; a `null` row takes one row away. Nothing else does.
- Card names that start with `iterate-cloud-`, `keys-` or `lent-` are the platform's: a package
  must not use them.
- The mind's default config lists every secret that no package row shows under "Keys and
  accounts". A secret named `<integration>-<connection>`, or ending with
  `-<integration>-<connection>`, of a registered row is shown by that row alone: name a
  connection's secret so (`/secrets/own-acme-main` for the row `acme/main`).

**The checklist.** A package author checks each line:

1. Register in the install hook (`mind/worker-updated`): the card, then a row per connection.
2. Append only what changed, or key each append by the triggering event
   (`<name>:registry:<path>@<offset>`), so a retry or a publish adds nothing new. Read
   `await itx.integrations.list()` (`{ integrations, connections }`) to compare.
3. Before setup, give the card **no status**, and make its first button the setup step ("Set up",
   "Connect"). Never show a setup instruction as a status.
4. Once a connection works, the card's status is the connections' ("Connected", "3 accounts"),
   whatever the setup secret's catalog entry says.
5. A row that is well is `{ kind: "ok" }` with no text. Words are for what a person must do.
6. A row's `details` hold at most two or three facts a person wants. No raw scope strings: say
   "Can: mail, calendar" in plain words. No internal ids, unless the provider's own page shows
   them to the person.
7. No two buttons with the same label to the same place on a card and its rows. A row's button
   manages that connection ("Manage", "Open"); a card's button adds another ("Add account") or
   opens the package's page.
8. Give every card a one-sentence description and, where you can, an `icon`.
9. When a connection goes, append its row as `null`. Listen for every way it can go: your page's
   Disconnect, its secret deleted elsewhere (`secret/deleted` whose `event.path` is the secret), and
   the provider's own uninstall or revoke event. Keep a tombstone until the `null` has landed.
10. In the install hook, reconcile: each connection whose secret the catalog
    (`itx.secrets.list()`) no longer has goes, and each row in `itx.integrations.list()` that the
    package no longer keeps gets a `null`.
11. When a setup secret is set or deleted on the Dash, no request of the package sees it. Its
    `events.iterate.com/secret/set` and `…/secret/deleted` facts land on the secret's own context
    only: `event.path` is `/secrets/<name>` (one name, no deeper), and that path is the secret. The
    root's log holds neither. Register the card again on that fact.
12. A process that is not the mind's worker (a bridge) registers no card: when it dies, nothing
    appends the `null`. The mind lists a live lend itself, by its description (below).

**A card and a row.**

```ts
const registry = itx.cd("/integrations");
await registry.append({
  type: "events.iterate.com/integration/configured",
  idempotencyKey: `acme:registry:${at}`, // `at` is the event's `${path}@${offset}`
  payload: {
    integration: "acme",
    card: {
      title: "Acme",
      description: "Acme's API as each connected account.",
      icon: "https://acme.example/mark.svg",
      // connected: a status; not yet: none, and the first button is the step to take
      status: { kind: "ok", text: "Connected" },
      actions: [{ label: "Add account", routingSlug: "acme", path: "/" }],
    },
  },
});
await registry.append({
  type: "events.iterate.com/integration/connection-configured",
  idempotencyKey: `acme:registry:main:${at}`,
  payload: {
    integration: "acme",
    connection: "main",
    row: {
      account: "ops@acme.example",
      status: { kind: "ok" },
      actions: [{ label: "Manage", routingSlug: "acme", path: "/" }],
    },
  },
});
```

**Removing.** A connection that goes: its row as `null`
(`{ integration: "acme", connection: "main", row: null }`). The package that goes: first take it out
of `worker.ts`; once that commit is live, append its card as `null`
(`{ integration: "acme", card: null }`), which takes its rows with it.

**Check it.** Every procedure in a README ends with this check, before the agent tells the person
it is done:

```js
async (itx) => {
  const { integrations, connections } = await itx.integrations.list();
  return {
    card: integrations.acme,
    rows: Object.fromEntries(
      Object.entries(connections).filter(([key]) => key.startsWith("acme/")),
    ),
  };
};
```

The card and rows must be what the README says they are after that procedure. If not, publish
the config repo again (the install hook makes them true), or append the `null` the README names.
Every string is capped, the state is kept within 1 MiB, and a malformed payload folds nothing:
parse each payload with the schemas from `iterate/integrations` in the package's tests.

**Bridges.** A file lent with `iterate provide` is listed by the mind while it is connected: its
rewrite rule in `itx.rewriteRules.list()` (`match: "itx.<name>"`) carries the `description` the
file exports, and the rule leaves the list when the program stops. The mind's default config lists
every live lend by itself under a heading "Lent by a computer": the card's title is `itx.<name>`,
and its description is the lend's own description cut to its first sentence and to 200
characters. So begin that description with one plain sentence that says what it is ("WhatsApp
messages, lent from a computer."); the rest is for the model. Check a lend with
`(await itx.rewriteRules.list()).find((rule) => rule.match === "itx.<name>")`.

## The archetypes

Every integration seen so far is one of these, or a mix.

**A service with its own page and webhook** (Telegram, ChatGPT). The page at `/` collects what the
service needs (`itx.secrets.collectFromUser` gives a link where the person pastes a token: the
package never sees it, and `redirectUrl`, the page's own URL, brings them back once it is saved), sets the webhook at the service to `/webhook/<name>` on the mind's host, and
registers a row. The webhook proves itself: `itx.secrets.verifyHmac(path, { payload, signature })`
for a signed body, `itx.secrets.verifyEquals(path, { value })` for a token in the URL. A secret
answers only the operations it was made with, so make it with the one its webhook calls:
`itx.secrets.collectFromUser({ path, egress, operations: ["verifyHmac"] })`, and the same option
for `set` and `beginOAuth`. Otherwise each check throws, and the webhook answers 500. Each delivery
lands once on `/integrations/<slug>/<connection>`, keyed by the service's delivery id. The page and
its forms send `Content-Security-Policy` with `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

**An OAuth app of the mind's own** (any OAuth provider). The provider comes back to iterate's own
callback, which completes the sign-in only in the browser that opened the start link, and only for
a member; then iterate sends the person to the package's page, which reads the result:

```ts
// register this URL at the provider: <platform origin>/.secrets/oauth/callback
const callbackUrl = await itx.secrets.oauthCallbackUrl();
const { authorizationUrl, nonce } = await itx.secrets.beginOAuth("/secrets/acme-main", {
  authorizationEndpoint,
  tokenEndpoint,
  clientId,
  clientSecret: 'getSecret("/secrets/acme-app", { field: "clientSecret" })',
  next: { routingSlug: "acme", path: "/connected?id=main" }, // a page of the mind's
  scope: "read",
});
// keep `nonce` for "main", send the person to authorizationUrl (iterate's start link); on /connected:
const result = await itx.secrets.oauthResult("/secrets/acme-main", { nonce });
// { status: "complete", scopes, account? } | { status: "pending" } | { status: "unavailable" }
```

The client is one secret, and a person enters it on one form:

```ts
const { url } = await itx.secrets.collectFromUser({
  path: "/secrets/acme-app",
  egress: { urls: ["https://auth.acme.example"] }, // the token endpoint's origin
  fields: [
    { name: "clientId", label: "Client ID", public: true, pattern: String.raw`[a-z0-9\-]{1,64}` },
    { name: "clientSecret", label: "Client secret" },
  ],
  redirectUrl: here, // this page's URL: the form sends the person back once it is saved
});
// the catalog answers a public field's value, and never a secret one
const app = (await itx.secrets.list()).find((entry) => entry.path === "/secrets/acme-app");
const clientId = app?.public?.clientId; // undefined until the person saves the form
```

A `public` field is no secret: the form shows it as a plain input, checked against its `pattern`
(HTML's, which the browser compiles with the `v` flag, so a hyphen in a character class is
escaped), and the catalog answers its value. The package reads the client ID there and keeps no
copy in its kv. A GitHub App's ID and slug are public fields of its secret in the same way.

The exchange runs in the platform's secret facet: the page never sees a token or a code. The platform
composes `next` by the deployment's static rules: on the hostname its config pins to the mind
when it has one, else under its ingress, so the landing is the mind's by construction. The page
shows iterate's callback, the one URL to register at the provider. A GitHub App's install has its own
setup URL, which is no OAuth sign-in (the `github` package): for a GitHub App, store one secret per installation with the App's key as a placeholder and
the `github-app-installation` refresh strategy: the platform mints each installation's token on use.
Claim a nonce once by appending an event with the nonce as its idempotency key and a body only
that claim has (a random value: the same event again is a no-op, so two identical claims would
both pass), prove a new installation through a temporary secret before replacing a working one,
and clear only the pending request the callback's nonce names.

**An API key, and a page that shows its status** (Monzo, Pebble, Waitrose, JMAP). The package's
README recipe has the agent collect the key into a secret pinned to the service's origin. Until that
secret exists, the install hook registers a card with no status and a first button, "Set up", to the
recipe; once it exists, the card is "OK". The page at `/` shows whether it does, with the URLs a
person pastes at the service. Where there are accounts to name, the hook registers a row for each
from the secrets that exist (Monzo's does), so a row goes when its secret goes. Outbound calls
spend the key as a placeholder, in plain `fetch`, by the README's examples.

**An event producer or consumer with no service** (a schedule, a mind-internal workflow). Only
`processEvent`: the install hook sets `itx.schedules.set({ key, when: { everyMs }, events })`, and the
schedule's event is the case the hook acts on.

Pick names that cannot collide: the platform owns `/secrets/<provider>-<connection>` and
`/integrations/<provider>/<connection>` for its shared apps (`slack`, `google`, `cloudflare`,
`github`, `x`), so a package uses a prefix of its own (`own-github-…`, `acme-…`). A connection's name
follows `[a-zA-Z0-9._-]{1,64}`.

## Testing

The package's own tests run in Node with a fake of the service: each page and webhook branch, each
registry payload (parse them with the schemas from `iterate/integrations`), a replayed webhook, a
nonce used twice at once, a disconnect whose secret deletion fails. Against a real platform, publish
the package to a mind and read `itx.integrations.list()`: the card appears after the worker is
published, each row matches a connection, and each button leads to the package's page in that
deployment's routing.

## Publishing the integration

A package is published like any npm package, and its README is the recipe a coding agent follows to
add it to a mind.

1. **Publish the code.** Either publish `iterate-<name>` to npm, or push it to a GitHub repository
   that builds it with [pkg.pr.new](https://pkg.pr.new) (every commit on `main` is then installable
   at `https://pkg.pr.new/<owner>/<repo>/iterate-<name>@<commit>`). The platform's loader installs a
   pkg.pr.new package only at a full commit, never at a branch name.
2. **Leave a README** with what the package does, which archetype it is, and the recipe's values for
   [add-to-a-mind.md](add-to-a-mind.md), the one script that adds any package to a mind's
   config repo: `PACKAGE` (the npm name), `IMPORT` (its import lines), `ELEMENT` (its element of the
   `integrations` array, such as `acme()`), `MEMBER` (a method to add to the worker's class, or empty)
   and `FILES` (new files, or none). Then the steps after the commit: a secret to collect, a webhook
   URL to paste at the service, a page to open. Then the events the package appends and their shapes,
   and how to remove it (its secrets, its kv keys, its rows). Each of these procedures ends with
   the check of the Integrations page above: the card and rows it must show, and what to run when
   they are wrong.
3. **Tell the agent where it is.** A person pastes the README's address into their coding agent, or
   the mind's `AGENTS.md` links it. The agent reads the recipe, runs the script with the recipe's
   values against the mind through iterate's MCP server, and the platform publishes the worker;
   the package's install hook registers it on the Integrations page, and the agent checks it there
   before it tells the person it is done.

The script pins the package at a full commit, adds the dependency to `package.json`, puts the import
and the element into `worker.ts`, probes the patched repo as a worker before committing, commits once
with the tip it read as parent, and waits for `mind/worker-updated`. It is safe to run twice.

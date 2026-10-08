# Adding an integration to iterate

An integration is a package a project hosts in its own config worker. The platform knows nothing of
the service: the package serves its own pages and webhooks on the project's host, keeps its
credentials through `itx.secrets`, and tells the Dash about itself. This guide says how to write one,
how to test it, and how to publish it so a coding agent can add it to any project from its README.
Each package here is a folder of its own; [add-to-a-project.md](add-to-a-project.md) is the one
script that adds any of them. To connect a service to one project without writing a package, a
coding agent follows `<platform origin>/connect-a-service.md` instead.

## The shape

A package exports one function that returns an `Integration` (`iterate/sdk`):

```ts
import type { Integration } from "iterate/sdk";

export function acme(options: { slug?: string } = {}): Integration {
  const routingSlug = options.slug ?? "acme";
  return {
    // the host it answers: acme--<project>.<ingress>, or <origin>/projects/<project>/acme/ under paths
    routingSlug,
    // every request on that host and no other: deliveries at /webhook, which prove themselves,
    // then for members only the provider's return at /oauth2/callback and the page at /
    async fetch(request, host) {
      const url = new URL(request.url);
      if (url.pathname === "/webhook") return receive(request, host.getItx());
      const denied = host.auth.require(request);
      if (denied) return denied;
      using itx = host.getItx();
      if (url.pathname === "/oauth2/callback") return callback(request, itx);
      return page(request, itx, routingSlug);
    },
    // every durable event of the project, unordered, at least once
    async processEvent({ event, itx }) {
      if (event.type === "events.iterate.com/project/worker-updated")
        await register(itx, routingSlug, `${event.path}@${event.offset}`);
    },
  };
}
```

A package's address has three places and no others. `/` is its page, for members. `/oauth2/callback`
is where a provider sends the member back, for members too. `/webhook` takes a service's deliveries,
which prove themselves (`/webhook/<name>` when a service has several). Those are the URLs a person
registers at the service.

The project's `worker.ts` lists it: `const integrations: Integration[] = [acme()];`. The worker hands
each element the requests on its routing slug and every event, after the project's own cases. A hook
returns for an event it does not handle: one that throws fails that event for the whole worker, which
the platform retries. Every reaction is an append keyed by the event's path and offset, so a retry
lands nothing twice.

What a package has: `host.getItx()` is the project's scope (`itx.secrets`, `itx.kv`, `itx.cd(path)`,
`itx.fetch` through the project's egress, `itx.schedules`); `host.auth.require(request)` is the member
gate. What it never has: a raw secret. A credential is set through `collectFromUser` or OAuth, pinned
to the hosts it may go to, and spent as a `getSecret("/secrets/<name>", { field })` placeholder in an
outbound request, which egress substitutes.

## Registering on the Dash

The install hook (the `project/worker-updated` case) appends the package's card on the project's
`/integrations` context, and one row per connection. Both are set semantics: the whole card or row
again whenever anything changes, `null` to take it away (a card's null takes its rows with it; a row
needs its card). The Dash shows what stands and changes nothing itself.

```ts
await itx.cd("/integrations").append(
  {
    type: "events.iterate.com/integration/configured",
    idempotencyKey: `acme:registry:${at}`,
    payload: {
      integration: "acme",
      card: {
        title: "Acme",
        description: "What it does, in one sentence.",
        status: { kind: "attention", text: "Connect an account" },
        actions: [{ label: "Connect", routingSlug: "acme", path: "/" }],
      },
    },
  },
  {
    type: "events.iterate.com/integration/connection-configured",
    idempotencyKey: `acme/main:registry:${at}`,
    payload: {
      integration: "acme",
      connection: "main",
      row: { account: "ops@acme.example", status: { kind: "ok" }, actions: [] },
    },
  },
);
```

A button's target is `{ routingSlug, path }`, a place in the project the Dash turns into a URL for the
deployment's routing, or `{ url }`. The schemas are `iterate/integrations`; every string is capped,
the state is kept within 1 MiB, and a malformed payload folds nothing. When a connection goes, append
its row as `null`; keep a tombstone until that append has landed and finish it at the next
publication, so a failed append cannot leave a stale row.

## The archetypes

Every integration seen so far is one of these, or a mix.

**A service with its own page and webhook** (Telegram, ChatGPT). The page at `/` collects what the
service needs (`itx.secrets.collectFromUser` gives a link where the person pastes a token: the
package never sees it), sets the webhook at the service to `/webhook/<name>` on the project's host, and
registers a row. The webhook proves itself: `itx.secrets.verifyHmac(path, { payload, signature })`
for a signed body, `itx.secrets.verifyEquals(path, { value })` for a token in the URL. Each delivery
lands once on `/integrations/<slug>/<connection>`, keyed by the service's delivery id. The page and
its forms send `Content-Security-Policy` with `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

**An OAuth app of the project's own** (a GitHub App, any OAuth provider). The page starts the attempt
with the package's own callback as the redirect, a place in the project the platform turns into the
URL the provider gets:

```ts
const { authorizationUrl } = await itx.secrets.beginOAuth("/secrets/acme-main", {
  authorizationEndpoint,
  tokenEndpoint,
  clientId,
  clientSecret: 'getSecret("/secrets/acme-app", { field: "clientSecret" })',
  redirect: { routingSlug: "acme", path: "/oauth2/callback" }, // register this URL at the provider
  scope: "read",
});
// the provider sends the person to /oauth2/callback?code=…&state=…; the page, for members only, hands both back
const { scopes } = await itx.secrets.completeOAuth("/secrets/acme-main", { code, state });
```

The exchange runs in the platform's secret facet: the page never sees a token, and the same callback
again (a refreshed tab) answers the same. The platform composes the URL under the deployment's
ingress, never a primary hostname, so a rename of the project moves it, and the provider's
registration must follow. For a GitHub App, store one secret per installation with the App's key as a placeholder and
the `github-app-installation` refresh strategy: the platform mints each installation's token on use.
Claim a nonce once by appending an event with the nonce as its idempotency key and a body only
that claim has (a random value: the same event again is a no-op, so two identical claims would
both pass), prove a new installation through a temporary secret before replacing a working one,
and clear only the pending request the callback's nonce names.

**An API key with no page** (Monzo, Pebble, Waitrose, JMAP). The package's README recipe has the agent
collect the key into a secret pinned to the service's origin; the install hook registers a card that
says "Set up by your coding agent: see the recipe" until that secret exists. Where there are
accounts to name, the recipe's own script appends a row for each (Monzo's does). Outbound calls
spend the key as a placeholder. A member the worker exposes (a method on the class, named in the
recipe) is what agents call.

**An event producer or consumer with no service** (a schedule, a project-internal workflow). Only
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
the package to a project and watch the Dash: the card appears after the worker is published, and each
button leads to the package's page in that deployment's routing.

## Publishing the integration

A package is published like any npm package, and its README is the recipe a coding agent follows to
add it to a project.

1. **Publish the code.** Either publish `iterate-<name>` to npm, or push it to a GitHub repository
   that builds it with [pkg.pr.new](https://pkg.pr.new) (every commit on `main` is then installable
   at `https://pkg.pr.new/<owner>/<repo>/iterate-<name>@<commit>`). The platform's loader installs a
   pkg.pr.new package only at a full commit, never at a branch name.
2. **Leave a README** with what the package does, which archetype it is, and the recipe's values for
   [add-to-a-project.md](add-to-a-project.md), the one script that adds any package to a project's
   config repo: `PACKAGE` (the npm name), `IMPORT` (its import lines), `ELEMENT` (its element of the
   `integrations` array, such as `acme()`), `MEMBER` (a method to add to the worker's class, or empty)
   and `FILES` (new files, or none). Then the steps after the commit: a secret to collect, a webhook
   URL to paste at the service, a page to open. Then the events the package appends and their shapes,
   and how to remove it (its secrets, its kv keys, its rows).
3. **Tell the agent where it is.** A person pastes the README's address into their coding agent, or
   the project's `AGENTS.md` links it. The agent reads the recipe, runs the script with the recipe's
   values against the project through iterate's MCP server, and the platform publishes the worker;
   the package's install hook registers it on the Dash.

The script pins the package at a full commit, adds the dependency to `package.json`, puts the import
and the element into `worker.ts`, probes the patched repo as a worker before committing, commits once
with the tip it read as parent, and waits for `project/worker-updated`. It is safe to run twice.

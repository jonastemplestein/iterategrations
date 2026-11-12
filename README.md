# iterategrations

Small integrations for [iterate](https://github.com/iterate/iterate) minds, one folder each. A
folder's `README.md` is the recipe: read it, then follow it. Each folder is also a package, built by
CI and served by [pkg.pr.new](https://pkg.pr.new) (never npm): a mind's config repo depends on
`https://pkg.pr.new/jonastemplestein/iterategrations/<package>@<commit>`.

| Folder                                      | Package                                    | What it does                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`amazon/`](amazon)                         | `iterate-amazon`                           | Amazon UK search, basket and checkout through direct HTTP after Chrome login; local iterate bridge and Zinc alternative.                                                         |
| [`pebble/`](pebble)                         | `iterate-pebble`                           | Receive Pebble Index 01 ring recordings (transcript event + audio file).                                                                                                         |
| [`iphone-voice-notes/`](iphone-voice-notes) | `iterate-iphone-voice-notes`               | Voice notes from an iPhone shortcut (the Action Button): the audio as a file, transcribed by Whisper on Workers AI as an event.                                                  |
| [`waitrose/`](waitrose)                     | `iterate-waitrose`                         | The Waitrose grocery API with plain `fetch`: `waitroseFetch` adds the headers, `graphql` runs the app's operations, `placeOrder` guards the checkout.                            |
| [`arbor/`](arbor)                           | `iterate-arbor`                            | Arbor, the school MIS, as a parent sees it, with plain `fetch`: children, meals, messages, calendar, attendance, payments; `submitForm` sends the school's forms.                |
| [`seesaw/`](seesaw)                         | `iterate-seesaw`                           | Seesaw parent API client and CLI: journals, classes, activities, notifications and messages.                                                                                     |
| [`tapestry/`](tapestry)                     | `iterate-tapestry`                         | Tapestry Education Platform client and CLI: observations, messages and care diary pages.                                                                                         |
| [`monzo/`](monzo)                           | `iterate-monzo`                            | Monzo transactions as events (a webhook with a generated secret in its URL), and Monzo's API by tool name.                                                                       |
| [`yoto/`](yoto)                             | none                                       | Yoto players and library for a mind's agents: the mind signs in to Yoto itself.                                                                                                  |
| [`sonos/`](sonos)                           | none                                       | A Sonos system for a mind's agents, through Sonos's official MCP server.                                                                                                         |
| [`whatsapp/`](whatsapp)                     | none: run with `iterate provide`           | Your WhatsApp (Baileys, from your own computer) as `itx.whatsapp`, every message an event; a dummy to try it without an account.                                                 |
| [`whatsapp-calls/`](whatsapp-calls)         | none: run with `iterate provide`           | WhatsApp voice calls both ways, carried to the mind's voice app: `itx.whatsappCalls.call(…)` rings a person, and a known caller is picked up.                                    |
| [`phone-calls/`](phone-calls)               | none: run with `iterate provide`           | Real phone calls both ways on an Andrews & Arnold VoIP number (a SIP phone in Go), carried to the mind's voice app: `itx.phoneCalls.call(…)`.                                    |
| [`herdr/`](herdr)                           | none: a Herdr plugin, or `iterate provide` | Your Herdr as `itx.jonas.herdr`: one `call(method, params)` for Herdr's whole socket API, and its events on a stream (news durable, focus ephemeral).                            |
| [`jmap/`](jmap)                             | `iterate-jmap`                             | The mind's own Fastmail mailbox over JMAP, called with plain `fetch`: send (filed in Sent), search, threads, Masked Email. The package is a card and a status page.              |
| [`telegram/`](telegram)                     | `iterate-telegram`                         | A Telegram bot with its own Connect Telegram page: private chats and groups, each handed to an agent; invite links to let people in.                                             |
| [`chatgpt/`](chatgpt)                       | `iterate-chatgpt`                          | Bring your own ChatGPT: a Connect ChatGPT page, and model requests paid by the subscription instead of an API key.                                                               |
| [`chatgpt-desktop/`](chatgpt-desktop)       | none: run with `iterate provide`           | The ChatGPT desktop app's agent as `itx.jonas.chatgptDesktop`: website tasks in its in-app browser, `ask`/`send` by name, every turn and browser action an event.                |
| [`github/`](github)                         | `iterate-github`                           | A mind's own GitHub App, with a Connect GitHub page: each installation's webhooks as events, and its API with tokens the platform mints.                                         |
| [`google/`](google)                         | `iterate-google`                           | A mind's own Google OAuth client, with a Connect Google page: Google's APIs as each connected account, with tokens the platform refreshes.                                       |
| [`x/`](x)                                   | `iterate-x`                                | A mind's own X app, with a Connect X page: X's API as each connected account, with tokens the platform refreshes.                                                                |
| [`cloudflare/`](cloudflare)                 | `iterate-cloudflare`                       | A mind's own Cloudflare OAuth client, with a Connect Cloudflare page: Cloudflare's API as each connected person, on the account they picked, with tokens the platform refreshes. |

Seesaw and Tapestry are standalone API clients and CLIs. Import their client classes directly;
they do not register an integration card or worker route.

## Adding one to a mind

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
mind's root). How an integration reaches a mind depends on what it is:

- **A package** (`iterate-…` in the table: Pebble, iPhone voice notes, Waitrose, Monzo, JMAP, Telegram, ChatGPT, GitHub)
  runs in the mind's own config worker, as one element of its `integrations` array:
  `const integrations: Integration[] = [telegram(), github()];`. The worker hands each package the
  requests on its routing slug (its page, its webhook) and every event. A package's install hook
  registers its card, and a row for each connection (a bot, an installation, an account), on the
  mind's `/integrations`; the Dash's Integrations page shows them, with buttons to the package's
  page. [`add-to-a-mind.md`](add-to-a-mind.md) is the one script that pins it (a full pkg.pr.new
  commit), adds it to `package.json` and the array, probes the patched repo as a worker, commits it and
  waits for the platform to publish. Each recipe gives the values to put in its first block, then what
  to do next (a secret, a webhook, a page). Writing and publishing a package of your own:
  [`adding-an-integration.md`](adding-an-integration.md).
- **Lent from your own computer** (WhatsApp, WhatsApp calls, Herdr, ChatGPT desktop: "run with `iterate provide`"): one
  command lends it to the mind as `itx.<name>`. Each recipe says what to run and has a sample call.
- **A sign-in and a file** (Yoto; Monzo's API beside its package): the mind signs in to the service
  itself with `itx.secrets.beginOAuth`, and one file of plain `fetch` calls gives its agents the API
  by tool name.

Never take a secret in chat: a recipe that needs one makes a form with `itx.secrets.collectFromUser`.

[`zero-trust-mcp.md`](zero-trust-mcp.md) connects a
[zero-trust-mcp](https://github.com/iterate/zero-trust-mcp) server, which keeps no credentials of its
own, to a mind. No recipe here needs one: Monzo and Yoto connect directly. A folder without a
package is just a recipe.

## Working on this repo

This repository is public: [`AGENTS.md`](AGENTS.md) says what must never go into it (no personal
information).

pnpm and [Vite+](https://viteplus.dev) (oxfmt, oxlint with type checking, Vitest, tsdown):

```sh
pnpm install   # also builds every package (the tests and the type check read dist) and installs the pre-commit hook
pnpm check     # vp check: format, lint, type-check
pnpm test      # each package's tests, against a fresh build
```

A commit runs `vp check --fix` on its staged files. A package's build is its `vite.config.ts`
(`vp pack`); the rest of the toolchain is the root `vite.config.ts`.

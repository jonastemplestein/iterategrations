# iterategrations

Small integrations for [iterate](https://github.com/iterate/iterate) projects, one folder each. A
folder's `README.md` is the recipe: read it, then follow it. Each folder is also a package, built by
CI and served by [pkg.pr.new](https://pkg.pr.new) (never npm): a project's config repo depends on
`https://pkg.pr.new/jonastemplestein/iterategrations/<package>@<commit>`.

| Folder                                      | Package                                    | What it does                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`amazon/`](amazon)                         | `iterate-amazon`                           | Amazon UK search, basket and checkout through direct HTTP after Chrome login; local iterate bridge and Zinc alternative.                                                            |
| [`pebble/`](pebble)                         | `iterate-pebble`                           | Receive Pebble Index 01 ring recordings (transcript event + audio file).                                                                                                            |
| [`iphone-voice-notes/`](iphone-voice-notes) | `iterate-iphone-voice-notes`               | Voice notes from an iPhone shortcut (the Action Button): the audio as a file, transcribed by Whisper on Workers AI as an event.                                                     |
| [`waitrose/`](waitrose)                     | `iterate-waitrose`                         | The Waitrose grocery API with plain `fetch`: `waitroseFetch` adds the headers, `graphql` runs the app's operations, `placeOrder` guards the checkout.                               |
| [`monzo/`](monzo)                           | `iterate-monzo`                            | Monzo transactions as events (a webhook with a generated secret in its URL), signed in through zero-trust-mcp.                                                                      |
| [`yoto/`](yoto)                             | none                                       | Yoto players and library for a project's agents, connected through zero-trust-mcp.                                                                                                  |
| [`whatsapp/`](whatsapp)                     | none: run with `iterate provide`           | Your WhatsApp (Baileys, from your own computer) as `itx.whatsapp`, every message an event; a dummy to try it without an account.                                                    |
| [`whatsapp-calls/`](whatsapp-calls)         | none: run with `iterate provide`           | WhatsApp voice calls both ways, carried to the project's voice app: `itx.whatsappCalls.call(…)` rings a person, and a known caller is picked up.                                    |
| [`phone-calls/`](phone-calls)               | none: run with `iterate provide`           | Real phone calls both ways on an Andrews & Arnold VoIP number (a SIP phone in Go), carried to the project's voice app: `itx.phoneCalls.call(…)`.                                    |
| [`herdr/`](herdr)                           | none: a Herdr plugin, or `iterate provide` | Your Herdr as `itx.jonas.herdr`: one `call(method, params)` for Herdr's whole socket API, and its events on a stream (news durable, focus ephemeral).                               |
| [`jmap/`](jmap)                             | `iterate-jmap`                             | The project's own Fastmail mailbox over JMAP, called with plain `fetch`: send (filed in Sent), search, threads, Masked Email. The package is a card and a status page.              |
| [`telegram/`](telegram)                     | `iterate-telegram`                         | A Telegram bot with its own Connect Telegram page: private chats and groups, each handed to an agent; invite links to let people in.                                                |
| [`chatgpt/`](chatgpt)                       | `iterate-chatgpt`                          | Bring your own ChatGPT: a Connect ChatGPT page, and model requests paid by the subscription instead of an API key.                                                                  |
| [`chatgpt-desktop/`](chatgpt-desktop)       | none: run with `iterate provide`           | The ChatGPT desktop app's agent as `itx.jonas.chatgptDesktop`: website tasks in its in-app browser, `ask`/`send` by name, every turn and browser action an event.                   |
| [`github/`](github)                         | `iterate-github`                           | A project's own GitHub App, with a Connect GitHub page: each installation's webhooks as events, and its API with tokens the platform mints.                                         |
| [`google/`](google)                         | `iterate-google`                           | A project's own Google OAuth client, with a Connect Google page: Google's APIs as each connected account, with tokens the platform refreshes.                                       |
| [`x/`](x)                                   | `iterate-x`                                | A project's own X app, with a Connect X page: X's API as each connected account, with tokens the platform refreshes.                                                                |
| [`cloudflare/`](cloudflare)                 | `iterate-cloudflare`                       | A project's own Cloudflare OAuth client, with a Connect Cloudflare page: Cloudflare's API as each connected person, on the account they picked, with tokens the platform refreshes. |

## Adding one to a project

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root). How an integration reaches a project depends on what it is:

- **A package** (`iterate-…` in the table: Pebble, iPhone voice notes, Waitrose, Monzo, JMAP, Telegram, ChatGPT, GitHub)
  runs in the project's own config worker, as one element of its `integrations` array:
  `const integrations: Integration[] = [telegram(), github()];`. The worker hands each package the
  requests on its routing slug (its page, its webhook) and every event. A package's install hook
  registers its card, and a row for each connection (a bot, an installation, an account), on the
  project's `/integrations`; the Dash's Integrations page shows them, with buttons to the package's
  page. [`add-to-a-project.md`](add-to-a-project.md) is the one script that pins it (a full pkg.pr.new
  commit), adds it to `package.json` and the array, probes the patched repo as a worker, commits it and
  waits for the platform to publish. Each recipe gives the values to put in its first block, then what
  to do next (a secret, a webhook, a page). Writing and publishing a package of your own:
  [`adding-an-integration.md`](adding-an-integration.md).
- **Lent from your own computer** (WhatsApp, WhatsApp calls, Herdr, ChatGPT desktop: "run with `iterate provide`"): one
  command lends it to the project as `itx.<name>`. Each recipe says what to run and has a sample call.
- **Through zero-trust-mcp** (Monzo's sign-in, Yoto): [`zero-trust-mcp.md`](zero-trust-mcp.md) connects
  the server; the recipe then calls its tools.

Never take a secret in chat: a recipe that needs one makes a form with `itx.secrets.collectFromUser`.

[`zero-trust-mcp.md`](zero-trust-mcp.md) is the shared step behind Monzo and Yoto: connecting a
[zero-trust-mcp](https://github.com/iterate/zero-trust-mcp) server, which keeps no credentials of its
own, to a project. A folder without a package is just a recipe.

## Working on this repo

pnpm and [Vite+](https://viteplus.dev) (oxfmt, oxlint with type checking, Vitest, tsdown):

```sh
pnpm install   # also builds every package (the tests and the type check read dist) and installs the pre-commit hook
pnpm check     # vp check: format, lint, type-check
pnpm test      # each package's tests, against a fresh build
```

A commit runs `vp check --fix` on its staged files. A package's build is its `vite.config.ts`
(`vp pack`); the rest of the toolchain is the root `vite.config.ts`.

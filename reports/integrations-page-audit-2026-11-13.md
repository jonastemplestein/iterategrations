# Integrations page audit, 13 November 2026

What each folder of this repository puts on a mind's Integrations page, and what was wrong with
it against the page as it is now (iterate/core `core/lib/src/integrations.ts`, and the Dash's
`packages/ui/src/components/integrations-page.tsx`). Line numbers are of this change.

## How the page works now

- A **card** is one integration: title, one-sentence description, icon, status, at most four
  buttons. A card that other cards name as their `section` is drawn as a heading. A card with no
  section stands under "This mind's own".
- A **row** is one connection under its card: account, status, buttons, a few details.
- A **status** is a dot and words. `{ kind: "ok" }` with no text is only a dot on a row, and "OK"
  on a card. The card's header shows the worst status of the card and its rows.
- A card with **no status and no row** draws its first button dark: the one thing to do.
- The registry is set semantics. A card or row goes only when its package appends `null`. The page
  has no expiry.

## The table

Kind: **package** (a mind's config worker hosts it, `integrations` array), **bridge** (a process
on a computer lends it with `iterate provide`), **recipe** (a README and at most a file for the
mind's config), **library** (a client and CLI, no worker).

| Folder                | Kind                                             | Card (file:line)                                                  | Rows                                                                                      | Removed (null)                                                                         | What was wrong (before this change)                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amazon/`             | bridge (`itx.amazon`), also a library            | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page (a bridge). Description led with method names, not what it is.                                                                                                                                                                                                        |
| `arbor/`              | package                                          | `arbor/src/index.ts:143`                                          | none                                                                                      | card: README, by hand                                                                  | Amber "Set up by your coding agent: see the recipe" as a status with nothing set up; the setup button was not first.                                                                                                                                                                  |
| `chatgpt/`            | package                                          | `chatgpt/src/registry.ts:56`                                      | one, `chatgpt/account` (`:72`)                                                            | row: when `/secrets/chatgpt` is gone, at the next publish or page action; card: README | "Manage" on the card and on the row, to the same page. Amber "Connect ChatGPT" status. A secret deleted on the Dash left the row until the next publish.                                                                                                                              |
| `chatgpt-desktop/`    | bridge (`itx.<name>.chatgptDesktop`)             | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page (a bridge). Description is clear.                                                                                                                                                                                                                                     |
| `cloudflare/`         | package ("own app")                              | `cloudflare/src/registry.ts:89`                                   | one per connected person (`:144`)                                                         | row: Disconnect, tombstone; card: README                                               | Card status gated on the client's public ID: "Create an OAuth client and paste its secret" above working rows. "Manage" on card and row. Row details had raw scopes and account ids. A secret deleted outside the page left its row.                                                  |
| `github/`             | package ("own app")                              | `github/src/registry.ts:104`                                      | one per installation or request (`:161`)                                                  | row: Remove, tombstone; card: README                                                   | Card status was the App's only: "Create a GitHub App and paste its secrets" above working installations, and a green "OK" with no installation. "Manage" on card and row. Row showed the installation id. An uninstall at GitHub, or a secret deleted outside the page, left the row. |
| `google/`             | package ("own app")                              | `google/src/registry.ts:90`                                       | one per account (`:162`)                                                                  | row: Disconnect, tombstone; card: README                                               | As Cloudflare, with a raw scope list in each row.                                                                                                                                                                                                                                     |
| `herdr/`              | bridge (`itx.<name>.herdr`), and a Herdr plugin  | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page (a bridge). Description began with the bare label ("Herdr.").                                                                                                                                                                                                         |
| `iphone-voice-notes/` | package                                          | `iphone-voice-notes/src/iphone-voice-notes.ts:321`                | none                                                                                      | card: README                                                                           | Amber "Open it to set the token" status before setup. The card changed only at a publish.                                                                                                                                                                                             |
| `jmap/`               | package                                          | `jmap/src/integration.ts:104`                                     | none                                                                                      | card: README                                                                           | Amber setup status before setup. The card changed only at a publish.                                                                                                                                                                                                                  |
| `monzo/`              | package, and a sign-in and a file                | `monzo/src/monzo.ts:188`                                          | one per account (`monzo/src/monzo.ts:198`); before, the recipe's own script appended them | row: by hand only; card: README                                                        | Amber setup status. Rows showed Monzo's account id. A row stayed after its webhook secret was deleted: nothing appended its null.                                                                                                                                                     |
| `pebble/`             | package (one card per receiver)                  | `pebble/src/pebble.ts:325`                                        | none                                                                                      | card: README                                                                           | Amber setup status. The card changed only at a publish.                                                                                                                                                                                                                               |
| `phone-calls/`        | bridge (`itx.phoneCalls`), a Go SIP phone        | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page (a bridge).                                                                                                                                                                                                                                                           |
| `seesaw/`             | library and CLI                                  | none                                                              | none                                                                                      | n/a                                                                                    | Nothing: no worker, nothing to show.                                                                                                                                                                                                                                                  |
| `sonos/`              | recipe (Sonos's MCP server)                      | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page. The connection is the mind's MCP connection, not a package's.                                                                                                                                                                                                        |
| `tapestry/`           | library and CLI                                  | none                                                              | none                                                                                      | n/a                                                                                    | Nothing.                                                                                                                                                                                                                                                                              |
| `telegram/`           | package                                          | `telegram/src/bot.ts:255` (through `telegram/src/registry.ts:68`) | one per bot (`telegram/src/bot.ts:268`)                                                   | row: Disconnect, tombstone; card: README                                               | "Manage" on the card and the row (the owner's complaint 3). Amber "Connect a bot" status. A bot whose token secret is deleted outside the page keeps its row (not changed: see below).                                                                                                |
| `waitrose/`           | package                                          | `waitrose/src/index.ts:116`                                       | none                                                                                      | card: README                                                                           | Amber setup status. The card changed only at a publish.                                                                                                                                                                                                                               |
| `whatsapp/`           | bridge (`itx.whatsapp` or `itx.whatsapp.<name>`) | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page (the owner's complaint 5). Description began with the account's label and Baileys, not what it is.                                                                                                                                                                    |
| `whatsapp-calls/`     | bridge (`itx.whatsappCalls`)                     | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page (a bridge).                                                                                                                                                                                                                                                           |
| `x/`                  | package ("own app")                              | `x/src/registry.ts:89`                                            | one per account (`:136`)                                                                  | row: Disconnect, tombstone; card: README                                               | As Cloudflare (complaints 1 to 4). The stale `@…` row: the row comes from the package's kv (`own-x/accounts/<connection>`), which a secret deleted outside the page never touched, and each publish registered the row again.                                                         |
| `yoto/`               | recipe (a sign-in and one file, `yoto.ts`)       | none                                                              | none                                                                                      | n/a                                                                                    | Not on the page: the file has no install hook.                                                                                                                                                                                                                                        |

`reports/`, `research/`, `research_notes/` and `zero-trust-mcp.md` are notes, not integrations.

## Why WhatsApp is not on the page

WhatsApp, WhatsApp calls, phone calls, Amazon, the ChatGPT desktop app and Herdr are bridges. Each
is a file that `iterate provide <file> --name <name> --mind <address>` runs on a computer. The
file's functions are lent to the mind as `itx.<name>` while the process is connected. No worker of
the mind hosts it, so no install hook runs, and nothing appends a card.

### How each bridge reaches the mind

| Bridge             | Runs with                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp/`        | The computer's own sign-in (`iterate login`): it acts as that member. Its README says `--key` is not supported yet, since its events would not land.                          |
| `whatsapp-calls/`  | The computer's own sign-in.                                                                                                                                                   |
| `phone-calls/`     | The computer's own sign-in.                                                                                                                                                   |
| `amazon/`          | The computer's own sign-in (`iterate login`).                                                                                                                                 |
| `chatgpt-desktop/` | The computer's own sign-in.                                                                                                                                                   |
| `herdr/`           | Either the computer's own sign-in, or, for a plugin target that ends in `key`, a key of its own (`--key`, with `--paths <log path's parent>/`, `herdr/plugin/bridge.sh:130`). |

### Could a bridge append its own card?

- **With a person's sign-in**: yes. The file gets the mind's `itx` as that member, and a member may
  append on `/integrations`.
- **With a key** (`--key`): only by a signed statement. `core/mind-worker/src/lender-root.ts`
  gives a key's token only `whoami` and `provide` of its own name. Its events go through the
  bridge's `append`, a signed statement that the auth Worker takes only at a path under the key's
  `paths` (`core/auth-worker/src/statements.ts:41`). Paths must start with `/integrations/`
  (`core/auth-worker/src/key-rules.ts`, `serviceKeyRequestOf`). `underPaths` compares whole
  segments after it strips the trailing slash, so a key enrolled with `--paths /integrations/`
  would reach `/integrations` itself, and `integration` is not in the auth Worker's list of
  platform namespaces. Herdr's plugin asks for `/integrations/herdr/` only, which does not reach
  `/integrations`. This was read in the source; it is not tested on a deployed stack.
- **Either way it should not.** A bridge that crashes, loses its network, or has its computer
  asleep appends no `null`. The page has no expiry, so its card would say "connected" for a lend
  that is gone. No bridge here registers a card, and this change adds none.

### What the mind already knows about a live lend

While a bridge is connected, the mind's root has a rewrite rule for it (`itx.rewriteRules.list()`):

- `match`: `itx.<name>`, for example `itx.whatsapp`, `itx.whatsapp.<name>`, `itx.phoneCalls`,
  `itx.amazon`;
- `target`: `itx.builtins.rpcStubs.get('<name>')`, the live stub of the connection;
- `description`: the `description` that the bridge's file exports, one line of at most 500
  characters.

The platform's own config can list live lends on the Integrations page from these rows. So each
bridge's description now begins with one plain sentence that says what it is:

| Bridge             | The description's first sentence                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp/`        | `<WHATSAPP_ACCOUNT, default "A WhatsApp account">: WhatsApp messages, lent from a computer.` (`whatsapp/src/whatsapp.ts`) |
| `whatsapp/` dummy  | `A PRETEND WhatsApp (whatsapp.ts's lend over a socket that talks to nobody): …` (unchanged)                               |
| `whatsapp-calls/`  | `WhatsApp voice calls both ways on the agents' own number, lent from a computer.`                                         |
| `phone-calls/`     | `Phone calls both ways on the agents' own number, lent from a computer.`                                                  |
| `amazon/`          | `Amazon UK search, basket and checkout, lent from a computer that signed in with Chrome.`                                 |
| `chatgpt-desktop/` | `<CHATGPT_DESKTOP_LABEL>, which does website tasks in the app's in-app browser.` (unchanged)                              |
| `herdr/`           | `<HERDR_LABEL, default "Herdr">: a Herdr workspace, lent from a computer.`                                                |

Verified on a deployed mind (13 November): a lend's rule leaves `rewriteRules.list()` within
seconds when its program stops. The mind's default config (iterate/private#834) lists every live
lend under the heading "Lent by a computer": title `itx.<name>`, description cut to its first
sentence and to 200 characters.

## What this change does about it

- **Own-app cards (X, Google, Cloudflare, GitHub).** The card's status is its connections', never
  the setup's: "Connected" or "N accounts" once one is connected, else no status and one button
  that is the next step ("Set up", then "Connect an account" or "Install"). The card's button adds
  another ("Add account", "Install on another account"); the row's "Manage" manages that one.
  Rows carry no scopes and no ids: Google says "Can: mail, calendar, drive", Cloudflare names the
  account. Each card has an https icon URL of its own.
- **Stale rows.** An account's `secret/deleted`, which lands on the secret's own context (`event.path` is
  `/secrets/<name>`; the root's log holds none), takes its row away at once. The publish hook
  takes away every account whose secret the catalog no longer has, and appends a null for each row
  the registry holds that the package does not keep (`itx.integrations.list()`). GitHub also takes
  an installation away when GitHub sends its `installation` delivery with action `deleted`.
- **Telegram, ChatGPT.** No duplicate "Manage"; no amber status before setup. ChatGPT registers
  again on its secret's fact.
- **API-key cards (Arbor, iPhone voice notes, JMAP, Monzo, Pebble, Waitrose).** No status before
  setup, and "Set up" first. JMAP, Monzo, Pebble, Waitrose and iPhone voice notes now register
  again when their secret is set or deleted. Monzo's hook keeps a row per account whose webhook
  secret exists, and nulls a row whose secret is gone; the recipe's script no longer appends it.

Not changed: Telegram's rows do not yet follow a token secret deleted outside the page (its
`TelegramItx` has no `secrets.list`; Disconnect on its page and the tombstone keep the row true
otherwise). Icons for Cloudflare and Telegram stay as they were (none, and a favicon URL): the Dash
serves no mark for them.

## Platform names and secret names

The default config (iterate/private#834) owns card names that start with `iterate-cloud-`, `keys-`
and `lent-`; no package here uses one (Pebble's `integration` option is a person's choice, and
should not start with them either). It lists under "Keys and accounts" every secret that no row
shows; a row shows the secret named `<integration>-<connection>` or ending with
`-<integration>-<connection>`.

| Package    | Row                        | Its secret                              | Follows it                                                                               |
| ---------- | -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| x          | `x/<connection>`           | `/secrets/own-x-<connection>`           | yes                                                                                      |
| google     | `google/<connection>`      | `/secrets/own-google-<connection>`      | yes                                                                                      |
| cloudflare | `cloudflare/<connection>`  | `/secrets/own-cloudflare-<connection>`  | yes                                                                                      |
| github     | `github/<installation id>` | `/secrets/own-github-<installation id>` | yes (a request row has no secret)                                                        |
| telegram   | `telegram/<bot>`           | `/secrets/telegram-<bot>`               | yes; `/secrets/telegram-webhook-<bot>` does not, and shows under "Keys and accounts"     |
| chatgpt    | `chatgpt/account`          | `/secrets/chatgpt`                      | **no**: it shows under "Keys and accounts" as well                                       |
| monzo      | `monzo/<name>`             | `/secrets/monzo-webhook-<name>`         | **no** (`-webhook-<name>`, not `-monzo-<name>`); the sign-in `/secrets/monzo` has no row |

The setup secrets (`/secrets/own-*-app`, and the key of each card without rows: arbor, jmap,
pebble, waitrose, iphone-voice-notes) have no row, so they show under "Keys and accounts". No
secret was renamed.

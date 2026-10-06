# Managed bots: Telegram in one tap

A design, not code. It says how a person connects Telegram with a few taps, on iterate's hosted
installation and on a self-hosted one, using only what any project's code can already do. Nothing in
it is privileged: the manager is ordinary project code, and the platform needs no new provider. The facts come from Telegram's
Bot API reference (Bot API 9.6, April 2026; read at 10.3) and its bot features page.

## What Telegram gives

A **manager bot** is an ordinary bot with _Bot Management Mode_ switched on in the @BotFather Mini
App. Anyone who opens this link makes a bot that the manager manages:

```
https://t.me/newbot/<manager_username>/<suggested_username>?name=<suggested name>
```

They see a window with the username and name filled in, and can edit both. Telegram checks that the
username is free. When they confirm:

1. The manager gets an update `managed_bot`, a `ManagedBotUpdated { user, bot }`. `user` made the
   bot and owns it. `bot` is the new bot. The same update also announces a changed token or owner,
   and has no field that says which it is: a `bot.id` never seen before is a creation.
2. `getManagedBotToken(user_id = bot.id)` answers the token.
3. `replaceManagedBotToken` revokes it and makes another.
4. `setManagedBotAccessSettings(user_id, is_access_restricted, added_user_ids ≤ 10)` limits who may
   write to the bot. The owner always may. This is Telegram's own allowlist, so for a managed bot
   our code need not keep one.

Also: a button (`request_managed_bot`, private chats only) does the same inside a chat. A bot can be
a manager and a normal bot. `managed_bot` arrives unless an earlier `allowed_updates` left it out.
Nothing says how many bots a manager may make. A person can own 20 bots (40 with Premium).

## Two traps

- **Anyone can make a link for your manager.** The username of a manager is public. A stranger who
  builds the link makes a bot under it, and the manager receives it. The receiver must accept only
  a `managed_bot` it expects, and must ignore the rest. Expect it by `user.id`, or by a one-time
  code inside the suggested username, which the connect step issued.
- **The manager holds every child's token.** Whoever holds the manager's token can fetch or replace
  any child's token. It is the most sensitive secret in the design. Never lend it to a project.

## The rule: the project pulls, the manager never pushes

The obvious design has the manager write each child's token into the person's project. A project
cannot do that to another project, and a token-writing right broad enough for it would let the
manager write anything. So the project asks for its token instead. The manager only answers.

Two parts, both plain project code:

- **The manager** is a config worker with a Telegram manager bot, a secret holding that bot's token,
  and three public routes. It runs in any project: on iterate Cloud in one that iterate owns, on a
  self-hosted deployment in one the operator owns.
- **The connecting project** runs this package, as it does today. It starts a connect, shows the
  person a link, waits, claims the token, and stores it as its own secret. From then on the manager is
  not in the path: Telegram sends updates straight to the project's webhook.

### One connect, step by step

1. **Start.** The project calls the manager: `POST /start`. The manager makes a random bot username
   (`iterate_<20 hex>_bot`) and a claim secret, keeps `{ username, hash(claim secret) }` for ten
   minutes, and answers the username, the claim secret and the link
   `t.me/newbot/<manager>/<username>?name=<project name>`. The project shows the person the link.
2. **Create.** The person taps it. Telegram shows the creation window with the name filled in. They
   tap Create. They own the new bot.
3. **Notice.** Telegram sends the manager `managed_bot { user, bot }`. The manager looks `bot.username`
   up in its pending list. No match, or an expired row: it does nothing (the first trap). A match: it
   calls `getManagedBotToken`, then `setManagedBotAccessSettings(restricted: true)` so only the owner
   can write to the bot, and holds `{ token, bot, owner user id }` under the claim hash.
4. **Claim.** The project, which has been waiting (`POST /claim`, a long poll), presents the claim
   secret. The manager answers the token, the bot's id and username, and the owner's Telegram user id,
   once, and forgets them.
5. **Wire.** The project stores the token as `/secrets/telegram-<bot>`, makes its own webhook secret,
   calls `setWebhook` to its own URL, and allows the owner's user id. The bot's first words, "You're
   in", go to the person's chat as soon as they tap Start.

No token, no BotFather, no user id typed. The person taps a link, taps Create, taps Start.

### Where each piece lives

- **Manager, hosted:** the `iterate` project's config worker, on a name such as
  `telegram.iterate.com`. iterate makes one manager bot, once.
- **Manager, self-hosted:** the operator makes a manager bot in @BotFather (Bot Management Mode on),
  stores its token as a secret of one project, and commits the manager package there. Every project
  on that deployment points at it.
- **The person's page:** a "Connect Telegram" page served by the person's own project (the `telegram`
  routing slug, members only, from the `x-itx-principal` header), with the button, the QR code for a
  desktop, and the wait. A coding agent can drive the same calls with no page.
- **The default template** ships the package and the page, so a new project has them on day one.

### What this costs, said plainly

- **The manager can fetch any child's token whenever it likes.** That is how Telegram built it. A
  person who does not accept it uses their own bot (the paste-a-token steps in the
  [README](README.md)), and a company can run its own manager. The page says which it is using.
- **The token passes through the manager once**, held ten minutes at most, encrypted at rest, and
  forgotten on claim.
- **A leaked link makes a stranger the owner.** The link is shown only to a signed-in member, lasts
  ten minutes, and works once. The project shows the owner's Telegram name before it allows them, and
  the person confirms it.
- **The username is the match key.** If the person edits it in the creation window, the manager
  cannot match the bot, and the page offers a new link.

### Not verified

What `ManagedBotUpdated.user` holds after an owner change, what Telegram does when a manager is
revoked, any rate limit on creations, and whether the creation window lets a person change the
username (it says the fields are "pre-filled, but editable"). Test each with a real manager bot.

## Built-in or not

Slack and GitHub are built in because iterate holds their apps. Nothing here needs that. The manager
holds Telegram's equivalent of an app, a manager bot, and it is code a project runs. The platform
could still list "Telegram" in the Dash's Connect sheet and open the page above, as a courtesy. That
is a link, not a privilege.

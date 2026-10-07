# Telegram

A Telegram bot for an iterate project, with a **Connect Telegram** page of its own. People write to the
bot in a private chat, or in a group, and each chat has an agent that answers.

It is project code: one element, `telegram()`, in the `integrations` array of the project's config
worker, which hands it the requests on the project's `telegram` routing slug, and every event. It
reaches Telegram with `fetch` alone. The project never sends the bot's token anywhere but
api.telegram.org. The token is kept as a secret, and iterate's egress swaps it in: the agent only
ever sends a placeholder naming the secret. Telegram puts the token in the URL path
(`/bot<token>/<method>`), so the placeholder goes there.

- **The page** (members only, at the project's `telegram` address, `/_/`): the BotFather steps, a form
  for the token, invite links, the people waiting to be let in, who is in, and a Disconnect button.
- **The webhook** (the same address, `/<bot>`): Telegram's, checked with a secret.
- **Private chats:** a message from someone who is in wakes that chat's agent. The chat shows
  "typing". Someone who is not in is told once that the bot is private, and waits on the page.
- **Groups:** add the bot to a group. People who are in can talk to it there. It answers when it is
  addressed (an @mention, a reply to it, a command, or its name as a word: "Hi Jeeves") and reads the
  rest as context.
- **Invites:** a one-time link, `t.me/<bot>?start=<code>`. The person opens it and taps Start. The bot
  says "You're in." Nobody types a user id. That is how a wife, a colleague or a second phone joins.
- **The Dash:** the project's Integrations page shows a Telegram card ("Connect a bot" until there is
  one) and a row per bot: its username, how many people are let in, and buttons to the page and to
  the bot in Telegram.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). The only code to commit is one dependency and one element of
`worker.ts`'s `integrations` array.

### 1. The package, in the config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and `telegram()` to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-telegram";
const IMPORT = 'import { telegram } from "iterate-telegram";';
const ELEMENT = "telegram()";
const MEMBER = "";
const FILES = {};
```

`telegram({ slug: "tg" })` answers another routing slug, and `telegram({ deliver: "events" })` hands
each message to the project's own agents (below). The project must have the agents app installed
(`installAgents`, as the default template does). Check that it is live. The webhook takes only
`POST`, so a `GET` is answered `405`, and that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "telegram", path: "/nope" });
  const res = await itx.fetch(new Request(url));
  return { url, status: res.status }; // 405 = the package is there. 404: not published yet
};
```

### 2. Send the person to the page

```js
async (itx) => itx.url({ routingSlug: "telegram", path: "/_/" });
```

Say: "Open this, sign in, and follow the steps." That is all. The page tells them to open
[@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and a username that ends in `bot`,
and paste the token BotFather gives. They tap **Connect**.

Tell them one thing before they start: **make the bot from an account that belongs to the company, not a
personal one.** Telegram has no developer account. The account that makes a bot owns it: it can read
the bot's messages and delete the bot. Give that account a number of its own, turn on two-step
verification, and keep its login in the company's password vault. (The owner can hand a bot to
another user: BotFather, `/mybots`, the bot, Transfer ownership.) "Telegram Business" is something
else; you do not need it.

If the address answers 404, the commit is not published yet.

### 3. Let people in, and use it

On the page, **Make an invite link** and send it to each person (to yourself too). They open it on a
phone with Telegram, and tap **Start**. Or they message the bot, and you press **Let in** beside their
name.

For a group, let in each person who should talk to it, then use the page's **Add @bot to a group as
admin** button (with a Copy button for the link). It is Telegram's own deep link,
`https://t.me/<bot>?startgroup&admin=manage_chat`: Telegram opens a picker of the groups the person can
add admins to, and makes the bot an admin when they confirm. **That matters because Telegram's privacy
mode is on by default:** a plain member bot is sent only the messages that @mention it, reply to it or
are commands, so "Hi Jeeves" never reaches it. An admin bot is sent every message. No Bot API call can
make a bot an admin or change privacy mode: only a person can, and the link is the shortest way. (The
other ways: Edit, Administrators, Add Administrator in the group; or `/setprivacy` to @BotFather, choose
the bot, **Disable**, then remove and re-add the bot.) The page asks Telegram which it is.

Then write the bot's username and where its page is into the project's `AGENTS.md`.

## What the agent gets

For each message from someone who is in, one `events.iterate.com/agent/context-added` on
`/agents/telegram/<bot>/chat-<chat id>` (a group's id is negative), keyed by the update. It says where
the message is from (a group's title), who wrote it, the text or caption, the attachments with their
`file_id`, and how to answer: a plain `itx.fetch` with the token placeholder, to any Bot API method,
and how to read a file. In a group the reply is aimed at the message it answers. A group message that
is not for the bot arrives with `llmRequestPolicy: { behaviour: "dont-trigger-request" }`: the agent
reads it on its next turn but does not wake for it.

Every update of every kind, from everyone, is also recorded as `telegram/update` on
`/integrations/telegram/<bot>` (`payload.update` is Telegram's `Update`, untouched). The bot's other
state is in the project's own `kv` (the root's; a sub-context has none): `telegram/<bot>/bot`,
`telegram/<bot>/allowed/<user id>`, `telegram/<bot>/pending/<user id>`, `telegram/<bot>/invite/<code>`,
and `telegram/bots/<bot>` for each connected bot.

What the Dash lists is on `/integrations` (iterate/integrations): `integration/configured` for the
card and `integration/connection-configured` for each bot's row, connection `<bot>`. The package
registers both again after every publish, and again whenever a bot is connected or disconnected or
someone is let in or out.

Disconnect deletes the bot's two secrets first. One that cannot be deleted is shown as an error, and
the bot stays listed, so Disconnect again can finish. A row the Dash could not be told to take away
is taken away by Disconnect again, or at the next publish: until then `telegram/removed/<bot>` in the
kv marks it.

## Good to know

- **The token passes through the page once.** The form posts it to the project's own worker, which
  checks it with Telegram's `getMe` and stores it as the secret `/secrets/telegram-<bot>`. It goes
  nowhere else. (A coding agent never takes it in chat: the person types it into the page.) The bot's
  name here is its username, lowercased, with `_` turned into `-`.
- **Who is in is a Telegram user id, not a chat.** A group does not let anyone in: each person must
  be let in. Someone who is not in, in a group, is ignored unless they address the bot, and then
  waits on the page, with no reply in the group.
- **"Typing" lasts about five seconds.** The bot sends it when a message wakes the agent; a long turn
  shows it only at the start.
- **At least once.** Telegram resends an update until the webhook answers 2xx. The agent's message
  is keyed by `update_id`, so it is added once.
- **Not handled:** edits, buttons, reactions and channels are recorded but reach no agent. The webhook
  subscribes to `message` only.
- **Limits.** A message holds 4096 characters. A bot sends about one message a second to one chat
  (twenty a minute to a group). A bot downloads files up to 20 MB.
- **Another bot:** paste a second token on the page.
- **Rotating a token:** `/token` in @BotFather, then paste the new token on the page: connecting
  again also makes a new webhook secret.

## When the project has agents of its own

By default each chat gets an agent here, and the agent answers by calling the Bot API. A project with
agents of its own (a chief of staff that already answers WhatsApp, say) lists
`telegram({ deliver: "events" })` instead. The package then keeps the door: who is let in, invites,
welcomes, who waits.
For each message from someone who is let in it records `telegram/message-accepted` on
`/integrations/telegram/<bot>`, keyed by the update, and routes nothing. The project routes that event
to its agents and sends their answers itself, with `api`, `placeholder` and `splitText`, which the
package exports. Its payload: `bot`, `updateId`, `messageId`, `chat { id, type, title }`, `threadId`,
`from { id, name, username }`, `text`, `caption`, `files [{ kind, fileId }]`, `location`,
`replyTo { messageId, fromId, text }` and `addressed` (whether the bot was @mentioned, replied to,
named or commanded). A service message is never accepted.

## One tap, later

[`managed-bots.md`](managed-bots.md) is a design for Telegram's managed bots, which would make the
bot from a link and skip @BotFather, for iterate Cloud. It is not built.

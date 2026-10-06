# Telegram

A Telegram bot for an iterate project, with a **Connect Telegram** page of its own. People write to the
bot in a private chat, or in a group, and each chat has an agent that answers.

It is project code: one partial `fetch`, `serveTelegram`, in the project's config worker, and `fetch`
and nothing else. The project never sends the bot's token anywhere but api.telegram.org. The token is
kept as a secret, and iterate's egress swaps it in: the agent only ever sends a placeholder naming
the secret. Telegram puts the token in the URL path (`/bot<token>/<method>`), so the placeholder
goes there.

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

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). The only code to commit is one dependency and one branch of `fetch`.

### 1. The package, in the config repo

Pin a commit of this repo's `main` (the loader only takes a pkg.pr.new package at a full commit):

```sh
curl -sI https://pkg.pr.new/jonastemplestein/iterategrations/iterate-telegram@main | grep -i x-commit-key
# x-commit-key: jonastemplestein:iterategrations:<40-hex sha>
```

In `package.json`, under `dependencies`:

```json
"iterate-telegram": "https://pkg.pr.new/jonastemplestein/iterategrations/iterate-telegram@<40-hex sha>"
```

`serveTelegram` is a partial `fetch`: it answers the requests that are Telegram's (the project's
`telegram` routing slug) and returns `null` for every other. In `worker.ts`, add this at the top of
`fetch`, with the import:

```ts
import { serveTelegram } from "iterate-telegram";

const telegram = await serveTelegram(request, {
  withItx: async <T>(call: (itx: any) => T): Promise<Awaited<T>> => {
    using itx = this.getItx();
    return await call(itx);
  },
  requireMember: (request) => this.auth.require(request),
});
if (telegram) return telegram;
```

Commit it in one commit with `itx.repos.get("/repos/config").commitFiles({ message, parent, changes })`,
`parent` being the tip you read. A commit to `main` publishes. The project must have the agents app
installed (`installAgents`, as the default template does).

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

For a group, add the bot to it and let in each person who should talk to it. **Telegram's privacy mode
is on by default:** the bot is then sent only the messages that @mention it, reply to it or are
commands, so "Hi Jeeves" never reaches it. The page asks Telegram and says which it is. To let the bot
hear everything, make it an admin of the group (it needs no rights), or send `/setprivacy` to
@BotFather, choose the bot, choose **Disable**, then remove the bot from the group and add it again.

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

## One tap, later

[`managed-bots.md`](managed-bots.md) is a design for Telegram's managed bots, which would make the
bot from a link and skip @BotFather, for iterate Cloud. It is not built.

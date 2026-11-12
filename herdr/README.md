# Herdr

[Herdr](https://herdr.dev), the terminal workspace manager for coding agents, in an iterate mind,
lent from the computer it runs on: `iterate provide` lends it as `itx.jonas.herdr`. It depends on no Herdr client: Herdr's socket takes one JSON line a
request, so `node:net` is the whole client.

- **One function, all of Herdr's API.** `itx.jonas.herdr.call(method, params)` sends Herdr's own
  [socket API](https://herdr.dev/docs/socket-api) request and answers its result: workspaces, tabs,
  panes, agents (`agent.list`, `agent.get`, `agent.read`, `agent.prompt`, `agent.wait`, `agent.start`),
  worktrees, layouts, plugins, notifications, `session.snapshot`. A wrong name is answered with Herdr's
  own error, which lists every method. Params are Herdr's: `herdr api schema --json` prints them.
- **Every event lands on a stream**, `/integrations/herdr/primary` (`HERDR_LOG_PATH`), as
  `herdr/<kind>` with Herdr's data under `payload.data`; the kinds are Herdr's own, in underscores
  (`pane_agent_status_changed`, `pane_created`, `worktree_opened`, …).

  |                     | Kinds                                                                                                                                                                                                                                                                      | Kept                                                                                                     |
  | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
  | **Durable**         | `snapshot` (the whole session, at every connection), `workspace_created` / `closed` / `renamed`, `worktree_created` / `opened` / `removed`, `tab_created` / `closed` / `renamed`, `pane_created` / `closed` / `exited`, `pane_agent_detected`, `pane_agent_status_changed` | Yes.                                                                                                     |
  | **Ephemeral**       | `workspace_focused`, `tab_focused`, `pane_focused`, `layout_updated`, `pane_updated`, `workspace_updated`, `workspace_metadata_updated`, `*_moved`, `workspace_reordered`                                                                                                  | No: live subscribers only, and a subscriber names the type to get it (`"*"` never matches an ephemeral). |
  | **Never asked for** | `pane.scroll_changed` (four fifths of Herdr's events, and no news), `pane.output_matched`                                                                                                                                                                                  | Read output with `call("pane.read", { pane_id, source: "recent" })` instead.                             |

  Durable events are news; ephemeral ones are "right now", which a snapshot rebuilds. It is as simple
  as it sounds: one `events.subscribe` connection, no queue, no replay. Herdr keeps only its last 512
  events, a handoff (`herdr update --handoff`) interrupts subscriptions, and its docs say events
  cannot be replayed over a snapshot. So when Herdr's connection ends the bridge dials again and
  appends a fresh `herdr/snapshot`, and so does a mind that reconnects: what happened while one
  side was away is lost, and the snapshot says where things stand.

- **Panes.** Herdr's `pane.agent_status_changed` needs a pane, so the connection subscribes to the panes
  there are when it opens. A `pane_created`, `pane_closed`, `pane_exited`, `tab_closed` or
  `workspace_closed` ends it, and the next connection starts with the new set (and a snapshot):
  Herdr closes a tab's panes without a `pane_closed` for each.

```js
async (itx) => {
  const { agents } = await itx.jonas.herdr.call("agent.list");
  return agents
    .filter((agent) => agent.agent_status === "blocked")
    .map((agent) => ({ title: agent.terminal_title_stripped, workspace: agent.workspace_id }));
};
```

**Everything it lends is Herdr's whole API**, `pane.send_text` and `server.stop` included: it is
control of the computer's terminals. Share it only with a mind you trust.

## The agents in its panes, in the mind's list of agents

[`agent-kinds/herdr.ts`](agent-kinds/herdr.ts) is an agent kind: copy it to the mind's config repo as
`agent-kinds/herdr.ts` and name it in `worker.ts`'s `agentKinds`. It reads the events above and
keeps one agent for each pane that runs a coding agent (Claude Code, Codex, opencode, …), at
`/agents/<person>/herdr/<computer>/<pane>`. `<person>` is the member whose sign-in the bridge runs
on, by the start of their address (`sam@example.com` is `sam`), so each member's agents are in a
folder of their own. A bridge on a key has no person: its agents are at
`/agents/herdr/<computer>/<pane>`. `<computer>` is the last part of the stream's path
(`HERDR_LOG_PATH`), so give each computer a stream of its own.

- Such an agent is in `itx.agents.list()` and in the Agents app with the other agents: kind
  `herdr`, the computer as its `host`, the pane's title, what runs there and in which folder, and
  `working`, `waiting` (Herdr's `blocked`), `idle` or `ended`. `lastActivityAt` is when Herdr last
  said something about it.
- An agent that was listed before its person had a folder ends at the bridge's next connection
  and is listed again in the folder. Its old context stays where it was, with what Herdr said.
- An agent that appears between two snapshots says what it is (`claude in a pane`); its pane's
  title and folder come with the next snapshot. A title that changes later is seen at the next
  snapshot too: Herdr's `pane_updated` is ephemeral.
- It lists; it does not message. Words sent to such an agent reach nobody yet. The way in is the
  call above: `itx.jonas.herdr.call("agent.prompt", { target: "<pane id>", text })`.
- The file has no imports, so a mind's worker and the Agents app's frame load it as it is.

## Run it

You need Node 22.18 or later, an `iterate` CLI that knows a mind (`npm install -g iterate@latest`;
`iterate provide --help` lists `--mind`) and this repository. It has no dependencies of its own.

```sh
git clone https://github.com/jonastemplestein/iterategrations && cd iterategrations
iterate login example.com
iterate provide herdr/src/herdr.ts --name jonas.herdr --mind example.com
```

- `--name jonas.herdr` is `itx.jonas.herdr`: a dotted name keeps all of one person's capabilities
  under `itx.jonas`.
- Without `--key`, the bridge uses your own sign-in (`iterate login example.com`) and acts as you.
  This is the usual way.
- `--key` and `--paths` give the bridge a key of its own, for a bridge that should hold less power.
  The first run prints a link to the mind's own page; a member opens it and presses Allow, once.
  Later runs connect with no sign-in. The key may lend that one name and add events under
  `--paths`, and nothing else. A member removes it on `https://iterate.<mind>/keys`. A key's event
  is a signed statement that is always kept, so with a key the bridge sends the news alone, not
  focus and layout.

It finds Herdr's socket the way Herdr does (`HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then the
default session). Stop with Ctrl-C.

## As a Herdr plugin

`herdr-plugin.toml` makes this a Herdr plugin, `iterate-bridge`: Herdr starts the lends itself, at every
server start and live handoff, and nothing else needs to run. A startup hook is one-shot, so
`plugin/bridge.sh start` starts one `iterate provide` for each line of the plugin's `targets` file in
the background, each redialing until stopped, and exits.

**First time**

1. You need Node 22.18 or later (npm and `npx` come with it). No `iterate` install is needed: without
   one that knows a mind, the plugin runs `npx iterate@latest` (the first start downloads it).
   `CLI` in `config.sh` names a copy instead.
2. Link the plugin: `git clone https://github.com/jonastemplestein/iterategrations`, then
   `herdr plugin link "$PWD/iterategrations/herdr"`.
3. Start it once: `herdr plugin action invoke iterate-bridge.restart` (or restart Herdr). With no `targets`
   file it writes a template, `$(herdr plugin config-dir iterate-bridge)/targets`, and shows a
   notification saying so. Edit it: one line a mind, `<the mind's address> [name] [key]`, such as
   `example.com jonas.herdr`.
4. Sign in to the mind: `iterate login example.com`. Run the restart action again; a target that was
   not signed in connects by itself once you are.

**Its own sign-in, or a key that may do less.** By default a bridge uses this computer's sign-in to
the mind and acts as you. A line that ends in `key` (`example.com jonas.herdr key`) gives the bridge
a key of its own: it may lend `itx.<name>` and add events under `/integrations/herdr/`, and nothing
else. A member allows the key once. The plugin shows a notification, and the link is in
`~/.local/state/herdr/plugins/iterate-bridge/<address>.allow-link`: open it, sign in to the mind
with your passkey and press Allow. The lend starts by itself, within 15 minutes of the link; after
that, the next try prints the same link again.

**What goes wrong shows on screen.** A startup hook's output is only in the plugin log, so the plugin
also raises a notification (by Herdr's own `ui.toast.delivery`: a macOS banner on a Mac) for: no `targets`
file (first run), a line that names no address, no Node 22.18, no `npx` and no CLI, a computer that is
not signed in or whose sign-in has ended, and a key that waits for a member. The last two are said at
most once in 12 hours for a mind.

- **`targets`**: one line a mind, its address, the capability's name, and `key` or nothing. A file
  from before minds (`<iterate config> <mind> [name]`) is refused line by line, with a
  notification.
- **The sign-in** is the CLI's own, kept by the CLI (`iterate login <address>`). A running lend
  renews it.
- **A key** is `<plugin config dir>/keys/<address>.key` (mode 600), one for each mind. It has no end
  date and needs no renewal: each connection gets a token for an hour with a statement the key
  signs. Whoever can read the file is the bridge. A member ends it on the mind's `/keys` page; the
  log then says that the mind gave the key no token.
- **`config.sh`** in the plugin's config dir is sourced when present: `HERDR_LABEL` (the name a model
  reads in the description), `HERDR_LOG_PATH`, and `NODE` / `CLI` if they are not found.
- **Actions**: `iterate-bridge.status`, `.restart`, `.stop` (the qualified id: `main-sync` also has a
  `status`). Logs are in `~/.local/state/herdr/plugins/iterate-bridge/<address>.log`, and
  `herdr plugin log list --plugin iterate-bridge` has what each action printed.
- **A second host** is the same plugin there, with its own `HERDR_LOG_PATH=/integrations/herdr/beelink`
  and `name` (`jonas.herdrBeelink`) in `targets`. Each host has its own sign-in, or its own key.
- **The CLI starts in the plugin's state dir.** Started inside a checkout of iterate, the `iterate`
  CLI runs that checkout's copy instead of itself, which may be an older one.
- Herdr's docs say plugins "must stop detached background processes before their parent command or pane
  exits" when an installation is replaced; a linked checkout is left alone, and `stop` ends them.

## Good to know

- **`call`, not `invoke`.** `invoke(expression)` is the platform's own dispatch method on every
  handle: a lent function of that name is shadowed, and the call fails inside the platform with
  `Cannot read properties of undefined`.
- **The description is one line of at most 500 characters.** The platform refuses a longer one when it
  lends (`a rewrite rule's description is one line`). The test checks it.
- **Node.** `iterate`'s pnpm shim runs pnpm's own Node (22.14 here), which cannot load a `.ts` file.
  `plugin/bridge.sh` runs the CLI's entry point with a Node that can (`NODE`).
- **Offline.** While the computer sleeps or Herdr is down, the mind's calls fail and no events
  land; a `herdr/snapshot` marks every reconnection.
- **The docs link** in the description is Herdr's `socket-api.mdx` at the tag of the installed version
  (v0.9.3): a model can fetch it as markdown. Change the tag in `description` when Herdr updates.
- **Ephemeral events** go only from a bridge that uses a person's sign-in. With a key, the bridge
  does not send them.

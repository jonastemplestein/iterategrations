# Herdr

[Herdr](https://herdr.dev), the terminal workspace manager for coding agents, in an iterate project,
lent from the computer it runs on: [`iterate provide`](https://github.com/iterate/iterate/tree/main/packages/cli#provide)
lends it as `itx.jonas.herdr`. It depends on no Herdr client: Herdr's socket takes one JSON line a
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
  appends a fresh `herdr/snapshot`, and so does a project that reconnects: what happened while one
  side was away is lost, and the snapshot says where things stand.

- **Panes.** Herdr's `pane.agent_status_changed` needs a pane, so the connection subscribes to the panes
  there are when it opens. A `pane_created`, `pane_closed` or `pane_exited` ends it, and the next
  connection starts with the new set (and a snapshot).

```js
async (itx) => {
  const { agents } = await itx.jonas.herdr.call("agent.list");
  return agents
    .filter((agent) => agent.agent_status === "blocked")
    .map((agent) => ({ title: agent.terminal_title_stripped, workspace: agent.workspace_id }));
};
```

**Everything it lends is Herdr's whole API**, `pane.send_text` and `server.stop` included: it is
control of the computer's terminals. Share it only with a project you trust.

## Run it

You need Node 22.18 or later, an `iterate` CLI with `provide` (`pnpm add -g iterate@latest`, then
`iterate login`) and this repository. It has no dependencies of its own.

```sh
git clone https://github.com/jonastemplestein/iterategrations && cd iterategrations
node "$(dirname "$(readlink -f "$(command -v iterate)")")/../bin/iterate.js" provide herdr/src/herdr.ts --name jonas.herdr --project <your project>
```

`--name jonas.herdr` is `itx.jonas.herdr`: a dotted name keeps all of one person's capabilities under
`itx.jonas`. It finds Herdr's socket the way Herdr does (`HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then
the default session). Stop with Ctrl-C.

## As a Herdr plugin

`herdr-plugin.toml` makes this a Herdr plugin, `iterate-bridge`: Herdr starts the lends itself, at every
server start and live handoff, and nothing else needs to run. A startup hook is one-shot, so
`plugin/bridge.sh start` starts one `iterate provide` for each line of the plugin's `targets` file in
the background, each redialing until stopped, and exits.

**First time**

1. You need Node 22.18 or later (npm and `npx` come with it). No `iterate` install is needed: without
   one, the plugin runs `npx iterate` (the first start downloads it). `npm install -g iterate` pins a
   copy instead, and `CLI` in `config.sh` names one.
2. Link the plugin: `git clone https://github.com/jonastemplestein/iterategrations`, then
   `herdr plugin link "$PWD/iterategrations/herdr"`.
3. Start it once: `herdr plugin action invoke iterate-bridge.restart` (or restart Herdr). With no `targets`
   file it writes a template, `$(herdr plugin config-dir iterate-bridge)/targets`, and shows a
   notification saying so. Edit it: one line a project, `<iterate config> <project> [name]`.
   `iterate --config <config> projects list` names the projects once you are signed in.
4. Sign in: `iterate --config <config> login` (or `npx iterate --config <config> login`). Run the
   restart action again; a target that was not signed in connects by itself once you are.

**What goes wrong shows on screen.** A startup hook's output is only in the plugin log, so the plugin
also raises a notification (by Herdr's own `ui.toast.delivery`: a macOS banner on a Mac) for: no `targets`
file (first run), no Node 22.18, no `npx` and no CLI, an iterate config name that does not exist, and a
config that is not signed in, and a sign-in that has ended (see below).

- **`targets`**: one line a project. An iterate config is a name from `iterate config list`; each is a
  deployment (`prd` is `os.iterate.com`; add your own with
  `iterate config set --name <name> --os-base-url <url>`).
- **How long a sign-in lasts.** `iterate login` gives an access token for an hour, renewed from a grant
  that dies after a week unused and in 30 days at most. A running lend renews itself, then stops when the
  grant ends. The plugin then shows a notification, at most once in 12 hours for a target (it reads the
  failed run's output: every sign-in error ends in "Run `iterate login` again"): sign in again, and the
  lend starts by itself. There is no warning in advance, because the CLI does not record when a grant
  ends. For a lend that outlives that, put a personal access token in `<plugin config dir>/<config>.key` (mode 600):
  `iterate --config <config> tokens create --project <project> --never-expires`. It acts as you on that
  project until you revoke it (`iterate tokens revoke`), and sits in that file in plain text.
- **`config.sh`** in the plugin's config dir is sourced when present: `HERDR_LABEL` (the name a model
  reads in the description), `HERDR_LOG_PATH`, and `NODE` / `CLI` if they are not found.
- **Actions**: `iterate-bridge.status`, `.restart`, `.stop` (the qualified id: `main-sync` also has a
  `status`). Logs are in `~/.local/state/herdr/plugins/iterate-bridge/<config>-<project>.log`, and
  `herdr plugin log list --plugin iterate-bridge` has what each action printed.
- **A second host** is the same plugin there, with its own `HERDR_LOG_PATH=/integrations/herdr/beelink`
  and `name` (`jonas.herdrBeelink`) in `targets`.
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
- **Offline.** While the computer sleeps or Herdr is down, the project's calls fail and no events
  land; a `herdr/snapshot` marks every reconnection.
- **The docs link** in the description is Herdr's `socket-api.mdx` at the tag of the installed version
  (v0.9.3): a model can fetch it as markdown. Change the tag in `description` when Herdr updates.
- **Ephemeral events from a session** work on the `iterate` project (checked 6 October). If a
  deployment refused them, the bridge says so once and drops them.

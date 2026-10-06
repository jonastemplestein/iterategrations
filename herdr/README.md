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

## Unattended

`herdr/launchd/` holds a LaunchAgent for a Mac.

1. A key of its own, because `iterate login` lasts 30 days at most:
   `iterate tokens create --name herdr-bridge --project <your project> --never-expires` (it signs in
   in the browser and prints the key once). Put it in `~/.config/herdr-iterate-bridge/token`, mode `600`.
2. Link and load it:

   ```sh
   ln -sf "$PWD/herdr/launchd/com.jonas.herdr-iterate-bridge.plist" ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jonas.herdr-iterate-bridge.plist
   ```

   Its log is `~/Library/Logs/herdr-iterate-bridge.log`. `launchctl kickstart -k gui/$(id -u)/com.jonas.herdr-iterate-bridge` restarts it.

`iterate provide` reconnects on its own, but gives up after about five minutes without the project;
`KeepAlive` starts it again. **A second host** is the same file with its own
`HERDR_LOG_PATH=/integrations/herdr/beelink` and `--name jonas.herdrBeelink`.

## Good to know

- **`call`, not `invoke`.** `invoke(expression)` is the platform's own dispatch method on every
  handle: a lent function of that name is shadowed, and the call fails inside the platform with
  `Cannot read properties of undefined`.
- **The description is one line of at most 500 characters.** The platform refuses a longer one when it
  lends (`a rewrite rule's description is one line`). The test checks it.
- **Node.** `iterate`'s pnpm shim runs pnpm's own Node (22.14 here), which cannot load a `.ts` file.
  `launchd/run.sh` runs the CLI's entry point with Homebrew's Node instead (`HERDR_BRIDGE_NODE`).
- **Offline.** While the computer sleeps or Herdr is down, the project's calls fail and no events
  land; a `herdr/snapshot` marks every reconnection.
- **The docs link** in the description is Herdr's `socket-api.mdx` at the tag of the installed version
  (v0.9.3): a model can fetch it as markdown. Change the tag in `description` when Herdr updates.
- **Ephemeral events from a session** work on the `iterate` project (checked 6 October). If a
  deployment refused them, the bridge says so once and drops them.

# ChatGPT desktop

The agent of the ChatGPT desktop app (OpenAI's ChatGPT app with Codex), lent to an iterate project
from the computer it runs on: [`iterate provide`](https://github.com/iterate/iterate/tree/main/packages/cli#provide)
lends it as `itx.jonas.chatgptDesktop`. That agent does website tasks in the app's in-app browser.
It depends on no client: the app serves its own agent tools on a Unix socket, so `node:net` is the
whole client.

- **Tasks.** `ask(task, { name })` starts a task in the app and answers when its turn ends, with
  `{ thread, name, status, answer }` (at most 4 minutes by default; then `wait(task)`). A task is a
  thread id or a name. `send(task, message)` adds a message to the same task: a follow-up, or the answer to
  a question the agent asked. Each task has its own browser tab, so several agents can work at once,
  and a task keeps its history, so it can be picked up days later. `start`, `wait`, `read`, `names`,
  `name`, `archive`; `call(tool, args)` is any of the app's agent tools (`call("tools")` lists them).
- **Events.** What the tasks started here (or by the `chatgpt-browser` command line in Jonas's agents
  repo) do lands on `/integrations/chatgpt-desktop/primary` (`CHATGPT_DESKTOP_LOG_PATH`):

  | Kind                             | Payload                                                              | Kept                                      |
  | -------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
  | `chatgpt-desktop/turn_started`   | `thread`, `name`, `turn`                                             | durable                                   |
  | `chatgpt-desktop/message`        | `phase` (`commentary` or `final_answer`), `text`                     | final answers durable, progress ephemeral |
  | `chatgpt-desktop/tool_call`      | `tool`, `title`, `input` (the browser code, cut at 4,000 characters) | durable                                   |
  | `chatgpt-desktop/turn_completed` | `turn`, `answer`, `durationMs`                                       | durable                                   |

  They come from the app's session files (`~/.codex/sessions`, one JSON line an item) of those tasks
  only. The app's own instructions, other sessions, tool outputs and reasoning are never read into
  events.

```js
async (itx) => {
  const first = await itx.jonas.chatgptDesktop.ask(
    "Open https://news.ycombinator.com and tell me the title of the top story.",
    { name: "hn-top" },
  );
  const more = await itx.jonas.chatgptDesktop.send("hn-top", "Open its comments; who posted it?");
  return [first.answer, more.answer];
};
```

**It lends a browser agent with the app's logins.** Whoever can use the project can send it to any
website as the app's signed-in account. Share it only with a project you trust.

## How it works

The app listens on `/tmp/codex-browser-use/<uuid>.sock`: a 4-byte little-endian length, then one
JSON-RPC message; `tools/list` and `tools/call`, the tools its own agent uses (`create_thread`,
`send_message_to_thread`, `wait_threads`, `read_thread`, …). The socket name changes when the app
starts; the lend finds the one that lists `create_thread`. Every call names a calling thread, so the
lend keeps one task in the app, **Agent bridge**, as the caller. A task's prompt starts with the
in-app browser's mention, `[@Browser](plugin://browser@openai-bundled)`. Names, the bridge and the
followed tasks are in `~/.local/state/chatgpt-browser/state.json`, shared with the command line under
a lock directory both honour.

The app's own settings decide what its agent may do without asking (Settings → Browser → agent
permissions, and the approval policy). A prompt it shows ends `ask` with status
`waiting-on-approval`; someone answers it in the app. OpenAI's confirmation policy inside the agent
still applies: before a payment, a deletion or sending a message it asks, and its answer is then a
question for `send`.

## Permissions: tasks are forks of a full-access template

A task that the app's `create_thread` makes runs in the app's workspace sandbox with approval on
request, even when its settings say Full access: a command that needs the network (such as `op`) stops
on an approval prompt in the app. A **fork** keeps its source's permissions, and a chat the app's own
screen starts has full access (approval never, `:danger-full-access`). So `ask` and `start` fork a
task named `agent-template` and send it the prompt. Make that task once, in the app: start a new chat
with the text "Reply ready; keep this task", then name it (`name("agent-template", threadId)`, or
`chatgpt-browser name agent-template ID`). It keeps almost no history, so a fork starts almost clean
(`wait` skips the turn a fork starts with). With no template, or a fork that fails, the task is made
the old way and the result carries a `hint` that it is sandboxed.

The agent still follows OpenAI's own browser rules inside the task: before it types a password, pays or
deletes it asks, and its answer is then a question for `send`. A task can read a login from 1Password
itself, in the same code that fills the form, so the value never appears in its output.

## Run it

You need Node 22.18 or later, an `iterate` CLI with `provide`, this repository, and the ChatGPT
desktop app running and signed in on the same computer (Linux tested; the app's socket path is the
same on macOS).

```sh
node "$(dirname "$(readlink -f "$(command -v iterate)")")/../bin/iterate.js" provide chatgpt-desktop/src/chatgpt-desktop.ts --name jonas.chatgptDesktop --project <your project>
```

`CHATGPT_DESKTOP_LABEL` says whose app it is in the description a model reads. Stop with Ctrl-C.

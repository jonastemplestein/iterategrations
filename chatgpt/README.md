# ChatGPT

Bring your own ChatGPT: a **Connect ChatGPT** page of its own, and Responses API requests that a
ChatGPT plan pays for (Plus or Pro), not an API key.

It is project code: one element, `chatgpt()`, in the `integrations` array of the project's config
worker. It uses OpenAI's
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for open-source
tools. There is no OAuth app to register: the page signs in as `dynamic_agent_client`, and OpenAI
registers a public client for that person during the consent. The tokens are one secret,
`/secrets/chatgpt`, pinned to `api.openai.com` and `auth.openai.com`. The package ships no API
client: project code and agents call OpenAI with plain `fetch` and a placeholder for the token, and
iterate's egress swaps in the real token ([Calling the Responses API](#calling-the-responses-api)).
When OpenAI answers 401, the platform runs the secret's exchange code (in `src/auth.ts`), which
trades the refresh token for a new token and keeps the rotated refresh token.

- **The page** (members only, at the project's `chatgpt` address): a Connect button, the consent
  link and a box for the address OpenAI sends the browser to, who is connected and their plan, a
  **Test it** button, a Disconnect button, and a usage snippet.
- **The Dash:** the project's Integrations page shows a ChatGPT card ("Connect ChatGPT" until it is
  connected, with a button to the page) and, once connected, the account's row: its address and
  plan. The package registers both again after every publish, and whenever the page connects or
  disconnects. The Dash takes nothing away itself: Disconnect appends the row's null, and if that
  append fails, the next publish appends it again.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat: the person signs in at OpenAI, and nothing here asks for a password).

### 1. The package, in the config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It adds the import
and `chatgpt()` to the `integrations` array of `worker.ts`:

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-chatgpt";
const IMPORT = 'import { chatgpt } from "iterate-chatgpt";';
const ELEMENT = "chatgpt()";
const MEMBER = "";
const FILES = {};
```

`chatgpt({ slug: "openai" })` answers another routing slug.

Check that it is live. The page answers members only, so a request with no sign-in is refused, and
that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "chatgpt", path: "/" });
  const res = await fetch(url, { redirect: "manual" });
  return { url, status: res.status }; // 401/302/403: the page is there and wants a member. 404: not published yet
};
```

### 2. Send the person to the page

```js
async (itx) => itx.url({ routingSlug: "chatgpt", path: "/" });
```

Say: "Open this, sign in, press **Connect ChatGPT**, then open the consent link. When your browser
fails to load `http://127.0.0.1:1455/…`, copy that whole address and paste it in the box."
The person needs a **personal Plus or Pro** ChatGPT account. OpenAI offers the plan's usage in a
preview for those. A Team or Business workspace may be refused.

Then press **Test it** on the page: it asks one model for one word.

### 3. Make the project's own model calls use it

The package makes the connection. A project whose code calls `https://api.openai.com/v1/responses`
with `Bearer getSecret("/secrets/openai")` switches to the plan in two places. The header names the
plan's token:

```js
authorization: 'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })',
```

And the body follows the plan's rules in [Calling the Responses API](#calling-the-responses-api):
`stream: true`, `store: false`, `input` as a list, none of the refused fields, and the answer read
from the stream.

## Calling the Responses API

Read this before the first call. The package exports no API client. Project code, a `run` script or
an agent calls OpenAI's Responses API with `fetch`. In every worker the platform loads (the
project's config worker, a `run` script) the global `fetch` is the project's egress.

- **Endpoint:** `POST https://api.openai.com/v1/responses`.
- **Token:** the header
  `authorization: 'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })'`. Egress swaps
  the placeholder for the real token on the way out.
- **Origins:** the secret is pinned to `https://api.openai.com` and `https://auth.openai.com` (where
  the platform refreshes it). Egress sends the token nowhere else.
- **Expiry:** do nothing. When OpenAI answers 401, the platform refreshes the token and sends the
  request again, once. A 401 that reaches you means the refresh failed: the person connects ChatGPT
  again.

A plan's token differs from api.openai.com's own docs
([OpenAI's preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)):

- It answers only a stream: send `stream: true`, and read the server-sent events.
- It keeps nothing: send `store: false`. Each request carries the whole conversation.
- `input` is a list of messages, never a string. For a system prompt, use `instructions` or a
  `developer` message: a `system` message is refused.
- It refuses these fields: `background`, `conversation`, `max_output_tokens`, `max_tool_calls`,
  `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`,
  `temperature`, `top_logprobs`, `top_p`, `truncation`, `user` and `previous_response_id`.
- It does not take image generation, file search, the code interpreter, computer use or hosted MCP
  tools. Function tools go in a `namespace` tool, or in an `additional_tools` input item.

This `run` script asks one question and returns the answer. Project code uses the same lines.

```js
async () => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: 'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })',
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-6.1-sol",
      input: [{ role: "user", content: "Say hello." }],
      stream: true,
      store: false,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI answered ${response.status}: ${await response.text()}`);
  // server-sent events: blocks split by a blank line, each with `data:` lines of JSON
  let text = "";
  for (const block of (await response.text()).replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "") continue;
    const event = JSON.parse(data);
    if (event.type === "response.output_text.delta") text += event.delta;
    if (event.type === "response.completed") return text;
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "response.failed" || event.type === "response.incomplete")
      throw new Error(JSON.stringify(event.response.error ?? event.response.incomplete_details));
  }
  throw new Error("the stream ended before response.completed");
};
```

The answer is complete only at `response.completed`. A plan's usage limit can end a stream that
has begun, as `response.failed`.

`GET https://api.openai.com/v1/models`, with the same header, lists the models the token can see:
`{ models: [{ slug, visibility }] }`, not the API's `{ data: [{ id }] }`. Use a `slug` whose
`visibility` is `"list"`. Everything else is in
[OpenAI's Responses API reference](https://developers.openai.com/api/reference/resources/responses).

## Good to know

- **Only the Responses API.** Voice (Realtime, GPT-Live) and transcription refuse the token. Keep
  `/secrets/openai` for them.
- **Plus or Pro, personal, in a preview.** OpenAI says that to offer this in a paid or hosted app,
  you fill in [its interest form](https://openai.com/form/sign-in-with-chatgpt-interest). A person
  using their own plan in their own project is the open-source case.
- **Why a paste.** OpenAI sends a public client back only to a loopback address, so the browser
  cannot reach the project. The page asks for the address instead. The address holds a code that
  works once, and the page keeps the PKCE verifier, so a pasted address is useless to anyone else.
- **One connection per project:** `/secrets/chatgpt`. Connecting again replaces it. Each connection
  is a new app in the person's ChatGPT settings, where they can set its weekly limit and remove it.
- **A refresh token can die.** If the person removes the app in ChatGPT, a request answers 401 and
  the refresh says "connect ChatGPT again": press **Connect ChatGPT** again.
- **Not built:** revoking the app at OpenAI on Disconnect (the revoke call needs the token in the
  request body, which egress never fills in), a second plan, and counting a request's cost.
- **Disconnect** deletes `/secrets/chatgpt` first. If it cannot be deleted, the page says so and
  ChatGPT stays connected, so Disconnect again can finish.
- **Removing it.** Disconnect on the page, take `chatgpt()` and its import out of `worker.ts`, and
  once that commit is live take the card off with its null, which takes any row left with it:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "chatgpt", card: null } })`.

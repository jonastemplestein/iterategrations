# ChatGPT

Bring your own ChatGPT: a **Connect ChatGPT** page of its own, and Responses API requests that a
ChatGPT plan pays for (Plus or Pro), not an API key.

It is project code: one partial `fetch`, `serveChatgpt`, in the project's config worker, plus a few
helpers that build the request. It uses OpenAI's
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for open-source
tools. There is no OAuth app to register: the page signs in as `dynamic_agent_client`, and OpenAI
registers a public client for that person during the consent. The tokens are one secret,
`/secrets/chatgpt`, pinned to `api.openai.com` and `auth.openai.com`. The agent only ever sends a
placeholder: iterate's egress swaps in the real token. When OpenAI answers 401, the platform runs the
secret's exchange code (this package's `EXCHANGE_SOURCE`), which trades the refresh token for a new
token and keeps the rotated refresh token.

- **The page** (members only, at the project's `chatgpt` address): a Connect button, the consent
  link and a box for the address OpenAI sends the browser to, who is connected and their plan, the
  models the token can see, a **Test it** button, a Disconnect button, and a usage snippet.
- **The requests:** `chatgptResponses(itx, body)` sends the body you would send to
  `https://api.openai.com/v1/responses`, adjusted for the plan (see below).
  `chatgptText(itx, { model, input })` returns the answer as text.

## Set it up

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat: the person signs in at OpenAI, and nothing here asks for a password).

### 1. The package, in the config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values:

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-chatgpt";
const SLUG = "chatgpt";
const IMPORT = 'import { serveChatgpt } from "iterate-chatgpt";';
const BRANCH = `const chatgptResponse = await serveChatgpt(request, {
  withItx: async <T>(call: (itx: any) => T): Promise<Awaited<T>> => {
    using itx = this.getItx();
    return await call(itx);
  },
  requireMember: (request) => this.auth.require(request),
});
if (chatgptResponse) return chatgptResponse;`;
const MEMBER = "";
const FILES = {};
```

Check that it is live. The page answers members only, so a request with no sign-in is refused, and
that is the proof:

```js
async (itx) => {
  const url = await itx.url({ routingSlug: "chatgpt", path: "/" });
  const res = await itx.fetch(new Request(url, { redirect: "manual" }));
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

The package makes the connection. A project whose agents call `https://api.openai.com/v1/responses`
with `Bearer getSecret("/secrets/openai")` switches to the plan like this:

```ts
import { chatgptResponses } from "iterate-chatgpt";

// before
const response = await itx.fetch(
  new Request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer getSecret("/secrets/openai")`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }),
);
// after: the same body, the same server-sent events back
const response = await chatgptResponses(itx, body, { signal });
```

`chatgptResponses` forces `stream: true` and `store: false`, makes a string `input` a list, and drops
the fields OpenAI refuses for a plan's token (`max_output_tokens`, `temperature`, `top_p`,
`previous_response_id`, `metadata`, `user`, and the others in
[the preview limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)).
Everything else is the Responses API's own: `tools`, `reasoning`, `prompt_cache_key`. The plan does
not take image generation, file search, the code interpreter, computer use or hosted MCP tools.

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
- **Models** are whatever the token can see. The page lists them (`chatgptModels(itx)` does too).
- **Not built:** revoking the app at OpenAI on Disconnect (the revoke call needs the token in the
  request body, which egress never fills in), a second plan, and counting a request's cost.

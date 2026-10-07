# ChatGPT

Bring your own ChatGPT: a **Connect ChatGPT** page of its own, and model requests that a ChatGPT
subscription pays for (Plus, Pro, Business or Enterprise), not an API key.

It is project code: one partial `fetch`, `serveChatgpt`, in the project's config worker, plus a few
helpers that build the request. It signs in the way the Codex CLI does (OpenAI's device code flow),
so there is no OAuth app to register and no callback to host. The tokens are one secret,
`/secrets/chatgpt`, pinned to `chatgpt.com` and `auth.openai.com`. The agent only ever sends
placeholders: iterate's egress swaps in the real tokens. When ChatGPT answers 401, the platform runs
the secret's exchange code (this package's `EXCHANGE_SOURCE`), which trades the refresh token for new
tokens and keeps the rotated refresh token.

- **The page** (members only, at the project's `chatgpt` address, `/_/`): a Connect button, the code
  to type at OpenAI, who is connected and their plan, the models the account can use, a **Test it**
  button, a Disconnect button, and a usage snippet.
- **The requests:** `chatgptResponses(itx, body)` sends the body you would send to
  `https://api.openai.com/v1/responses` to
  `https://chatgpt.com/backend-api/codex/responses`. `chatgptText(itx, { model, input })` returns the
  answer as text.

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
  const url = await itx.url({ routingSlug: "chatgpt", path: "/_/" });
  const res = await itx.fetch(new Request(url, { redirect: "manual" }));
  return { url, status: res.status }; // 401/302/403: the page is there and wants a member. 404: not published yet
};
```

### 2. Send the person to the page

```js
async (itx) => itx.url({ routingSlug: "chatgpt", path: "/_/" });
```

Say: "Open this, sign in, press **Connect ChatGPT**, then open the link it shows and type the code."
The page notices by itself when they have. If OpenAI says device code sign-in is off, the person turns
on **device code authorization for Codex** in ChatGPT's Settings, Security (a workspace admin may have
to).

Then press **Test it** on the page: it asks the account's first model for one word.

### 3. Make the project's own model calls use it

The package makes the connection. A project whose agents call `https://api.openai.com/v1/responses`
with `Bearer getSecret("/secrets/openai")` switches to ChatGPT by sending the same body to
`chatgptRequest`'s URL with `chatgptHeaders()`:

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

`chatgptResponses` forces `stream: true` and `store: false` (ChatGPT's backend takes only that), drops
`max_output_tokens`, `temperature` and `top_p` (it has no such knobs), and leaves everything else
alone: `tools`, `reasoning`, `include: ["reasoning.encrypted_content"]` and `prompt_cache_key` are
the Responses API's own. Usage is not billed in dollars: it counts against the plan's Codex limits.

## Good to know

- **It is Codex's sign-in.** The client id is the Codex CLI's, because OpenAI offers no way to
  register a client for a ChatGPT subscription. OpenAI can change or limit this at any time; read the
  plan's terms before pointing a company's agents at a person's subscription.
- **One connection per project:** `/secrets/chatgpt`. Connecting again replaces it.
- **The tokens pass through the page once.** The page's worker receives them from OpenAI, keeps them
  as the secret and never shows them.
- **A refresh token can die.** If the person signs out of ChatGPT everywhere, or the token is used
  twice, a request answers 401 and the refresh says "sign in again": press **Connect ChatGPT** again.
- **Models** are whatever the account may use. The page lists them (`chatgptModels(itx)` does too).
- **Not built:** a second subscription, the realtime voice API, and counting a request's cost.

import { CODEX_BASE, SECRET, type ChatgptItx } from "./auth.js";

/** The headers a ChatGPT model request carries. Neither token is here: both are placeholders, and
 *  iterate's egress swaps in the real values on the way to chatgpt.com, and only there. */
export function chatgptHeaders(sessionId?: string): Record<string, string> {
  return {
    authorization: `Bearer getSecret("${SECRET}", { field: "accessToken" })`,
    "chatgpt-account-id": `getSecret("${SECRET}", { field: "accountId" })`,
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: "iterate",
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/** What ChatGPT's backend refuses that the public API takes: it answers only a stream, keeps
 *  nothing (`store: false`) and has no output cap or sampling knobs. A body for api.openai.com
 *  becomes one for ChatGPT. */
export function chatgptBody(body: Record<string, unknown>): Record<string, unknown> {
  const { max_output_tokens: _cap, temperature: _t, top_p: _p, ...rest } = body;
  return { instructions: "", ...rest, stream: true, store: false };
}

/** One Responses API request to a ChatGPT subscription: the same body as for
 *  `https://api.openai.com/v1/responses` (`chatgptBody` adjusts it), sent to
 *  `https://chatgpt.com/backend-api/codex/responses`. */
export function chatgptRequest(
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; sessionId?: string } = {},
): Request {
  return new Request(`${CODEX_BASE}/responses`, {
    method: "POST",
    headers: chatgptHeaders(options.sessionId),
    body: JSON.stringify(chatgptBody(body)),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Send it: the SSE answer, as the Responses API streams it (`response.output_text.delta`, …,
 *  `response.completed`). A 401 is refreshed once by the platform, and the request goes again. */
export function chatgptResponses(
  itx: Pick<ChatgptItx, "fetch">,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; sessionId?: string } = {},
): Promise<Response> {
  return itx.fetch(chatgptRequest(body, options));
}

/** The `data:` payloads of a server-sent event stream, parsed; `[DONE]` and non-JSON are skipped. */
export async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): unknown[] => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data === "" || data === "[DONE]") return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [];
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        yield* parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    yield* parse(buffer);
  } finally {
    reader.releaseLock();
  }
}

/** A whole answer as text, for a caller that wants no stream: `chatgptText(itx, { model, input })`.
 *  Throws what ChatGPT says when the request fails. */
export async function chatgptText(
  itx: Pick<ChatgptItx, "fetch">,
  request: {
    model: string;
    input: string | unknown[];
    instructions?: string;
    effort?: "minimal" | "low" | "medium" | "high";
    signal?: AbortSignal;
  },
): Promise<string> {
  const { signal, effort, ...rest } = request;
  const response = await chatgptResponses(
    itx,
    {
      ...rest,
      input:
        typeof rest.input === "string"
          ? [{ type: "message", role: "user", content: [{ type: "input_text", text: rest.input }] }]
          : rest.input,
      ...(effort ? { reasoning: { effort } } : {}),
    },
    { signal },
  );
  if (!response.ok || !response.body)
    throw new Error(
      `chatgpt/${request.model} ${response.status}: ${(await response.text()).slice(0, 400)}`,
    );
  let text = "";
  for await (const event of serverEvents(response.body)) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string")
      text += event.delta;
    else if (event.type === "response.failed" || event.type === "error")
      throw new Error(
        `chatgpt: ${event.error?.message ?? event.response?.error?.message ?? event.type}`,
      );
  }
  return text;
}

/** The model names this ChatGPT account may use (`GET …/codex/models`). */
export async function chatgptModels(itx: Pick<ChatgptItx, "fetch">): Promise<string[]> {
  const response = await itx.fetch(
    new Request(`${CODEX_BASE}/models?client_version=1.0.0`, {
      headers: {
        authorization: chatgptHeaders().authorization!,
        "chatgpt-account-id": chatgptHeaders()["chatgpt-account-id"]!,
        originator: "iterate",
      },
    }),
  );
  if (!response.ok) throw new Error(`models: HTTP ${response.status}`);
  const body = (await response.json()) as { models?: { slug?: string }[] };
  return (body.models ?? []).flatMap((model) => (model.slug ? [model.slug] : []));
}

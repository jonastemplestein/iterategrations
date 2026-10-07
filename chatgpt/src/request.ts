import { RESOURCE, SECRET, type ChatgptItx } from "./auth.js";

/** The headers a model request carries. The token is a placeholder: iterate's egress swaps in the
 *  real value on the way to api.openai.com, and only there. */
export function chatgptHeaders(): Record<string, string> {
  return {
    authorization: `Bearer getSecret("${SECRET}", { field: "accessToken" })`,
    "content-type": "application/json",
    accept: "text/event-stream",
  };
}

/** What a plan's token may not send (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). */
const REFUSED = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** What the plan's token takes that api.openai.com's own key does not need: it answers only a
 *  stream, keeps nothing (`store: false`), wants `input` as a list, and refuses a few fields. A body
 *  for a plain API key becomes one for the plan. */
export function chatgptBody(body: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(body).filter(([key]) => !REFUSED.includes(key)));
  if (typeof rest.input === "string")
    rest.input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: rest.input }] },
    ];
  return { ...rest, stream: true, store: false };
}

/** One Responses API request paid by a ChatGPT plan: the body you would send to
 *  `https://api.openai.com/v1/responses` (`chatgptBody` adjusts it). */
export function chatgptRequest(
  body: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Request {
  return new Request(`${RESOURCE}/responses`, {
    method: "POST",
    headers: chatgptHeaders(),
    body: JSON.stringify(chatgptBody(body)),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Send it: the SSE answer, as the Responses API streams it (`response.output_text.delta`, …,
 *  `response.completed`). A 401 is refreshed once by the platform, and the request goes again. */
export function chatgptResponses(
  itx: Pick<ChatgptItx, "fetch">,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
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
 *  Throws what OpenAI says when the request fails. */
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
    { ...rest, ...(effort ? { reasoning: { effort } } : {}) },
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

/** The model names the plan's token can see (`GET /v1/models`). */
export async function chatgptModels(itx: Pick<ChatgptItx, "fetch">): Promise<string[]> {
  const response = await itx.fetch(
    new Request(`${RESOURCE}/models`, {
      headers: { authorization: chatgptHeaders().authorization! },
    }),
  );
  if (!response.ok) throw new Error(`models: HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).flatMap((model) => (model.id ? [model.id] : []));
}

import { servePage } from "./page.js";
import type { WithItx } from "./auth.js";

export {
  ACCOUNT_KEY,
  EXCHANGE_SOURCE,
  PIN,
  RESOURCE,
  SECRET,
  accountOf,
  claimsOf,
  isConnected,
  readAccount,
} from "./auth.js";
export type { Account, ChatgptItx, WithItx } from "./auth.js";
export {
  chatgptBody,
  chatgptHeaders,
  chatgptModels,
  chatgptRequest,
  chatgptResponses,
  chatgptText,
  serverEvents,
} from "./request.js";

/** A project's ChatGPT connection, as a partial `fetch`: it answers the requests that are its own
 *  (the project's `chatgpt` routing slug) and returns `null` for every other, so a worker chains
 *  it: `const chatgpt = await serveChatgpt(request, …); if (chatgpt) return chatgpt;`
 *
 *  What it answers: the Connect ChatGPT page at `/`, for members only. Any other path is a 404.
 *
 *  - `withItx`: `(call) => { using itx = this.getItx(); return call(itx); }`
 *  - `requireMember`: `(request) => this.auth.require(request)`: a `Response` to send, or null.
 *  - `slug`: the routing slug to answer on. Default `chatgpt`. */
export async function serveChatgpt(
  request: Request,
  options: {
    withItx: WithItx;
    requireMember(request: Request): Response | null;
    slug?: string;
  },
): Promise<Response | null> {
  if (request.headers.get("x-iterate-routing-slug") !== (options.slug ?? "chatgpt")) return null;
  return options.requireMember(request) ?? servePage(request, options.withItx);
}

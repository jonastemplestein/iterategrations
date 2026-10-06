import { servePage } from "./page.js";
import { type WithItx } from "./bot.js";
import { receiveUpdate } from "./webhook.js";

export { isAddressed } from "./webhook.js";
export { BOT_NAME, WELCOME, PRIVATE, placeholder, streamOf } from "./bot.js";
export type { TelegramItx, WithItx } from "./bot.js";

/** A project's Telegram, as a partial `fetch`: it answers the requests that are Telegram's, on the
 *  project's `telegram` routing slug, and returns `null` for every other, so a worker chains it:
 *  `const telegram = await serveTelegram(request, …); if (telegram) return telegram;`
 *
 *  What it answers: Telegram's webhook at `/<bot>` (checked with a secret) and, for members only, the
 *  Connect Telegram page at `/_/`.
 *
 *  - `withItx`: `(call) => { using itx = this.getItx(); return call(itx); }`
 *  - `requireMember`: `(request) => this.auth.require(request)`: a `Response` to send, or null.
 *  - `slug`: the routing slug to answer on. Default `telegram`. */
export async function serveTelegram(
  request: Request,
  options: { withItx: WithItx; requireMember(request: Request): Response | null; slug?: string },
): Promise<Response | null> {
  if (request.headers.get("x-iterate-routing-slug") !== (options.slug ?? "telegram")) return null;
  const { pathname } = new URL(request.url);
  if (pathname !== "/_" && !pathname.startsWith("/_/"))
    return receiveUpdate(request, options.withItx);
  return options.requireMember(request) ?? servePage(request, options.withItx);
}

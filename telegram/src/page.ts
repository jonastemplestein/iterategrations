import {
  allow,
  BOT_NAME,
  connectBot,
  disconnectBot,
  listBots,
  listPeople,
  makeInvite,
  readJson,
  say,
  streamOf,
  WELCOME,
  type BotInfo,
  type Pending,
  type Person,
  type WithItx,
} from "./bot.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

const STYLE = `
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  section { border: 1px solid #8884; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  input, button { font: inherit; padding: .5rem .75rem; border-radius: 8px; border: 1px solid #8886; }
  input { width: 100%; box-sizing: border-box; margin: .5rem 0; }
  button, .button { cursor: pointer; background: #2a7de1; color: #fff; border-color: #2a7de1; text-decoration: none; display: inline-block; padding: .5rem .75rem; border-radius: 8px; }
  button.quiet { background: none; color: inherit; border-color: #8886; }
  .error { background: #c0392b22; border: 1px solid #c0392b; border-radius: 8px; padding: .5rem .75rem; }
  .ok { background: #27ae6022; border: 1px solid #27ae60; border-radius: 8px; padding: .5rem .75rem; }
  .person { display: flex; gap: .5rem; align-items: center; justify-content: space-between; padding: .25rem 0; }
  .muted { opacity: .7; font-size: .9rem; } code { word-break: break-all; }
  form { display: inline; }
`;

const post = (action: string, fields: Record<string, string>, label: string, quiet = false) =>
  `<form method="post" action="${action}">${Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}" />`)
    .join("")}<button${quiet ? ' class="quiet"' : ""}>${label}</button></form>`;

const personLine = (p: Person & { id: string }) =>
  `${esc(p.name)}${p.username ? ` <span class="muted">@${esc(p.username)}</span>` : ""}`;

async function botCard(
  itx: Parameters<Parameters<WithItx>[0]>[0],
  bot: string,
  invite: string | null,
): Promise<string> {
  const info = await readJson<BotInfo>(itx, bot, "bot");
  const allowed = await listPeople<Person>(itx, bot, "allowed/");
  const pending = await listPeople<Pending>(itx, bot, "pending/");
  const link = invite && info ? `https://t.me/${info.username}?start=${invite}` : null;
  return `<section>
    <h2>@${esc(info?.username ?? bot)} <span class="muted">connected</span></h2>
    <p><a href="https://t.me/${esc(info?.username ?? "")}">Open it in Telegram</a></p>
    ${
      pending.length
        ? `<h2>Waiting to be let in</h2>${pending
            .map(
              (p) =>
                `<div class="person"><span>${personLine(p)}${p.chatTitle ? ` <span class="muted">in ${esc(p.chatTitle)}</span>` : ""}</span>${post("allow", { bot, id: p.id }, "Let in")}</div>`,
            )
            .join("")}`
        : ""
    }
    <h2>People who can use it</h2>
    ${
      allowed.length
        ? allowed
            .map(
              (p) =>
                `<div class="person"><span>${personLine(p)}</span>${post("remove", { bot, id: p.id }, "Remove", true)}</div>`,
            )
            .join("")
        : `<p class="muted">Nobody yet. Make an invite link, or message the bot yourself and let yourself in above.</p>`
    }
    ${
      link
        ? `<div class="ok"><p>Send this link to the person. They open it in Telegram and tap <b>Start</b>. It works once, for a week.</p><p><code>${esc(link)}</code></p></div>`
        : ""
    }
    ${post("invite", { bot }, "Make an invite link")}
    <h2>In a group</h2>
    <p class="muted">Add @${esc(info?.username ?? "")} to the group. It answers people you have let in, when they @mention it, reply to it or write a command. A bot sees only those messages unless you change that: in @BotFather send <code>/setprivacy</code>, choose the bot, choose <b>Disable</b>, then remove the bot from the group and add it again. It then reads everything and still answers only when it is addressed.</p>
    <p>${post("disconnect", { bot }, "Disconnect", true)}</p>
  </section>`;
}

const connectForm = (first: boolean) => `<section>
  <h2>${first ? "Connect a Telegram bot" : "Connect another bot"}</h2>
  <ol>
    <li>Open <a href="https://t.me/BotFather">@BotFather</a> in Telegram.</li>
    <li>Send <code>/newbot</code>. Give it a name, then a username that ends in <code>bot</code>.</li>
    <li>BotFather answers with a token. Paste it here.</li>
  </ol>
  <form method="post" action="connect">
    <input name="token" type="password" placeholder="123456:ABC-DEF…" autocomplete="off" required />
    <button>Connect</button>
  </form>
  <p class="muted">The token goes into this project's secrets and is only ever sent to api.telegram.org. Use an account that belongs to the company to make the bot: that account owns it.</p>
</section>`;

const redirect = (query = ""): Response =>
  new Response(null, { status: 303, headers: { location: `./${query}` } });
const flash = (key: "error" | "connected", text: string): string =>
  `?${key}=${encodeURIComponent(text)}`;

/** The members-only page at `/_/`: connect a bot, make invite links, let people in or out. Every
 *  write is a plain form POST, answered with a redirect back to the page. */
export async function servePage(request: Request, withItx: WithItx): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/_\/?/, "");
  const html = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

  if (request.method === "GET" && path === "") {
    const error = url.searchParams.get("error");
    const connected = url.searchParams.get("connected");
    const invite = url.searchParams.get("invite");
    const inviteBot = url.searchParams.get("bot");
    const body = await withItx(async (itx) => {
      const bots = await listBots(itx);
      let live: string | null = null; // an invite is shown only if it exists, for a bot that does
      if (invite && inviteBot && bots.includes(inviteBot) && /^[0-9a-f]{32}$/.test(invite))
        live = (await itx.cd(streamOf(inviteBot)).kv.get(`invite/${invite}`)) ? invite : null;
      const cards = await Promise.all(
        bots.map((bot) => botCard(itx, bot, bot === inviteBot ? live : null)),
      );
      return `${cards.join("")}${connectForm(bots.length === 0)}`;
    });
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Telegram</title><style>${STYLE}</style></head><body><h1>Telegram</h1>${
        error ? `<p class="error">${esc(error)}</p>` : ""
      }${connected ? `<p class="ok">Connected @${esc(connected)}. Open it in Telegram and send a message.</p>` : ""}${body}</body></html>`,
      {
        headers: {
          ...html,
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
        },
      },
    );
  }
  if (request.method === "GET" && url.pathname === "/_")
    return new Response(null, { status: 308, headers: { location: "_/" } });
  if (request.method !== "POST") return new Response("Not found\n", { status: 404 });

  const form = await request.formData();
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const bot = field("bot");
  const id = field("id");
  const basePath = request.headers.get("x-iterate-base-path") || "";
  try {
    if (path === "connect") {
      const { username } = await withItx((itx) =>
        connectBot(itx, field("token"), `${url.origin}${basePath}`),
      );
      return redirect(flash("connected", username));
    }
    const valid = BOT_NAME.test(bot) && (await withItx((itx) => listBots(itx))).includes(bot);
    if (!valid) return redirect(flash("error", "Unknown bot"));
    if (path === "invite") {
      const link = await withItx((itx) => makeInvite(itx, bot));
      return redirect(`?bot=${bot}&invite=${new URL(link).searchParams.get("start")}`);
    }
    if (path === "disconnect") await withItx((itx) => disconnectBot(itx, bot));
    else if (/^-?\d+$/.test(id) && path === "allow")
      await withItx(async (itx) => {
        const pending = await readJson<Pending>(itx, bot, `pending/${id}`);
        if (!pending) return;
        const { chatId, chatTitle: _title, ...person } = pending;
        await allow(itx, bot, id, person);
        await say(itx, bot, chatId, chatId === Number(id) ? WELCOME : `You're in, ${person.name}.`);
      });
    else if (/^-?\d+$/.test(id) && path === "remove")
      await withItx((itx) => itx.cd(streamOf(bot)).kv.delete(`allowed/${id}`));
    else return new Response("Not found\n", { status: 404 });
    return redirect();
  } catch (error) {
    return redirect(flash("error", error instanceof Error ? error.message : String(error)));
  }
}

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { CookieJar } from "tough-cookie";
import { amazonUrl } from "./web.js";
import type { WebFetch } from "./web.js";

type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
};
type SessionFile = {
  cookies?: BrowserCookie[];
  jar?: ReturnType<CookieJar["serializeSync"]>;
  userAgent: string;
};

/** A private cookie file, exported from the task's Chrome tab. No password goes to agents. */
export function createSessionFetch(path: string): WebFetch {
  if (statSync(path).mode & 0o077) throw new Error("amazon: session file must have mode 600");
  const session = JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  if (typeof session.userAgent !== "string" || !session.userAgent)
    throw new Error("amazon: session needs a userAgent");
  const jar = session.jar ? CookieJar.deserializeSync(session.jar) : new CookieJar();
  if (!session.jar)
    for (const c of session.cookies ?? []) {
      if (!["amazon.co.uk", "www.amazon.co.uk", ".amazon.co.uk"].includes(c.domain)) continue;
      jar.setCookieSync(
        `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}${c.secure ? "; Secure" : ""}${c.httpOnly ? "; HttpOnly" : ""}${c.expires && c.expires > 0 ? `; Expires=${new Date(c.expires * 1000).toUTCString()}` : ""}`,
        "https://www.amazon.co.uk",
      );
    }
  if (!jar.getCookieStringSync("https://www.amazon.co.uk"))
    throw new Error("amazon: empty cookie session");
  return async (request: Request): Promise<Response> => {
    const url = amazonUrl(request.url);
    const headers = new Headers(request.headers);
    headers.set("cookie", jar.getCookieStringSync(url.href));
    headers.set("user-agent", session.userAgent);
    const response = await fetch(
      new Request(request, { headers, redirect: "manual", signal: AbortSignal.timeout(45000) }),
    );
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url.href);
    writeFileSync(
      path,
      JSON.stringify({ userAgent: session.userAgent, jar: jar.serializeSync() }),
      { mode: 0o600 },
    );
    return response;
  };
}

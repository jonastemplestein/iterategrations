// A GMAIL ACCOUNT'S MAIL ON A STREAM, PUSHED RATHER THAN POLLED. Gmail publishes each change to
// the account's inbox and sent mail to a Pub/Sub topic (`watchGmail`, Gmail's `users.watch`), and
// the topic's push subscription POSTs each notification to the project (`receiveGmailPush`), which
// lands it on the account's stream as `gmail/push-received`. The project answers that event with a
// sync (`pullGmail`): each message the account receives or sends lands once on the stream as
// `gmail/message-added`, its attachments as project files beside it. Each call to Gmail is a plain
// `fetch` with the account's placeholder: in every worker the platform loads, the global `fetch` is
// the project's egress, which swaps the token in.
// https://developers.google.com/workspace/gmail/api/guides/push
import type { GoogleItx } from "./app.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** What a watch reports: mail that arrives in the inbox, and mail the account sends. Other changes
 *  (read, archived, relabelled) stay quiet: the stream records messages, nothing else. */
const WATCHED_LABELS = ["INBOX", "SENT"];
/** The most messages one sync adds: the rest wait for the next. */
const MAX_PER_RUN = 25;
/** A body longer than this is stored as a file the event names, not in the event. */
const BODY_MAX_CHARS = 256 * 1024;
/** Where a sync starts when it has no cursor, or when Gmail no longer keeps its history: the last
 *  day. */
const START = "newer_than:1d";

/** What a request to Gmail sends for the account's token: iterate's egress swaps the token in. */
const authorizationOf = (secret: string): string =>
  `Bearer getSecret(${JSON.stringify(secret)}, { field: "accessToken" })`;

/** An append that was made already is no error: Pub/Sub delivers again, and a sync can see a
 *  message twice. */
const once = (append: Promise<unknown>): Promise<unknown> =>
  append.catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
  });

/** The push subscription's POST. It answers 405 to any other method, and 401 unless the SHA-256 of
 *  the URL's `token` query parameter is `tokenSha256` (lowercase hex): the token lives only in the
 *  subscription's URL, and the project keeps its hash. Pub/Sub delivers again anything but a 2xx,
 *  so a body that is no Gmail notification, or one for an address that `streamOf` names no stream
 *  for, is acknowledged (204) and dropped. `streamOf` gets the address in lowercase. Otherwise
 *  `gmail/push-received` lands on that stream once per Pub/Sub message: `{ emailAddress,
 *  historyId, messageId, publishTime }`, nothing about the mail itself. */
export async function receiveGmailPush(
  request: Request,
  itx: Pick<GoogleItx, "cd">,
  options: { tokenSha256: string | null; streamOf: (emailAddress: string) => string | null },
): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!options.tokenSha256 || !token || (await sha256Hex(token)) !== options.tokenSha256)
    return new Response("bad token\n", { status: 401 });
  // { message: { data: base64 JSON { emailAddress, historyId }, messageId, publishTime } }
  const body = (await request.json().catch(() => null)) as {
    message?: { data?: string; messageId?: string; publishTime?: string };
  } | null;
  const message = body?.message;
  let data: { emailAddress?: string; historyId?: string | number } | null = null;
  try {
    data = JSON.parse(new TextDecoder().decode(bytesOf(message?.data ?? "")));
  } catch {
    data = null;
  }
  if (!message?.messageId || !data?.historyId) return new Response(null, { status: 204 });
  const path = options.streamOf(String(data.emailAddress ?? "").toLowerCase());
  if (!path) return new Response(null, { status: 204 });
  await once(
    itx.cd(path).append({
      type: "gmail/push-received",
      // a delivery again is the same notification
      idempotencyKey: `gmail-push:${message.messageId}`,
      payload: {
        emailAddress: String(data.emailAddress ?? ""),
        historyId: String(data.historyId),
        messageId: message.messageId,
        publishTime: message.publishTime ?? null,
      },
    }),
  );
  return new Response(null, { status: 204 });
}

/** Registers the watch, or renews it: Gmail publishes each change to the account's INBOX and SENT
 *  labels to `topicName` for the next 7 days. `secret` is the account's secret, whose access token
 *  egress swaps in. Records the watch on `path` as `gmail/watch-registered`, with its expiry, and
 *  answers the same. */
export async function watchGmail(
  itx: Pick<GoogleItx, "cd">,
  input: { secret: string; path: string; topicName: string },
): Promise<{ topicName: string; historyId: string; expiresAt: string }> {
  const response = await fetch(`${API}/watch`, {
    method: "POST",
    headers: { authorization: authorizationOf(input.secret), "content-type": "application/json" },
    body: JSON.stringify({
      topicName: input.topicName,
      labelIds: WATCHED_LABELS,
      labelFilterBehavior: "include",
    }),
  });
  if (!response.ok)
    throw new Error(
      `gmail watch answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  const { historyId, expiration } = (await response.json()) as {
    historyId: string;
    expiration: string;
  };
  const watch = {
    topicName: input.topicName,
    historyId: String(historyId),
    expiresAt: new Date(Number(expiration)).toISOString(),
  };
  await itx.cd(input.path).append({ type: "gmail/watch-registered", payload: watch });
  return watch;
}

type Cursor = { historyId: string; pending: string[] };
type Part = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
};
type Message = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
};
/** One GET of Gmail's API as the account: the JSON, or an error that carries the HTTP status. */
type Gmail = <T>(url: string) => Promise<T>;

/** The sync: what is new since the cursor (kv `gmail-sync:<path>`: Gmail's history id, and the ids
 *  still to fetch), at most 25 messages a call, oldest first; the rest wait for the next call.
 *  Each message lands once on `path` as `gmail/message-added`, its attachments, and a body over
 *  256 KiB, as project files under `<path>/<message id>/`. Drafts are skipped. The first call
 *  starts from the last day's mail, and so does one whose history Gmail no longer keeps (about a
 *  week). `secret` is the account's secret. Answers how many messages it added, how many wait,
 *  and the history id it has read to. */
export async function pullGmail(
  itx: Pick<GoogleItx, "kv" | "files" | "cd">,
  input: { secret: string; path: string },
): Promise<{ added: number; waiting: number; historyId: string }> {
  const { path } = input;
  const authorization = authorizationOf(input.secret);
  const gmail: Gmail = async (url) => {
    const response = await fetch(`${API}${url}`, { headers: { authorization } });
    if (!response.ok)
      throw Object.assign(
        new Error(
          `gmail ${url.split("?")[0]} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
        ),
        { status: response.status },
      );
    return response.json();
  };
  const cursorKey = `gmail-sync:${path}`;
  const stored = await itx.kv.get(cursorKey);
  let cursor: Cursor = stored ? (JSON.parse(stored) as Cursor) : await startCursor(gmail);
  try {
    // every page asks from the same start: a page token goes with the query that made it
    const start = cursor.historyId;
    let pageToken = "";
    do {
      const page = await gmail<{
        history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
        historyId?: string;
        nextPageToken?: string;
      }>(
        `/history?startHistoryId=${start}&historyTypes=messageAdded&maxResults=500${pageToken && `&pageToken=${pageToken}`}`,
      );
      for (const change of page.history ?? [])
        for (const { message } of change.messagesAdded ?? [])
          if (!message.labelIds?.includes("DRAFT") && !cursor.pending.includes(message.id))
            cursor.pending.push(message.id);
      cursor.historyId = page.historyId ?? cursor.historyId;
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    const fresh = await startCursor(gmail);
    cursor = {
      historyId: fresh.historyId,
      pending: [...new Set([...cursor.pending, ...fresh.pending])],
    };
  }
  await itx.kv.put(cursorKey, JSON.stringify(cursor));

  let added = 0;
  while (cursor.pending.length > 0 && added < MAX_PER_RUN) {
    const id = cursor.pending[0]!;
    // a message deleted since it arrived is gone: nothing to add
    const message = await gmail<Message>(`/messages/${id}?format=full`).catch((error: unknown) => {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    });
    if (message && !message.labelIds?.includes("DRAFT")) {
      await addMessage(itx, path, message, gmail);
      added++;
    }
    cursor.pending.shift();
    await itx.kv.put(cursorKey, JSON.stringify(cursor));
  }
  return { added, waiting: cursor.pending.length, historyId: cursor.historyId };
}

/** Where a sync starts: the account's history id now, then the ids of the last day's mail, oldest
 *  first (read after the id, so a message that lands between is in both and fetched once). */
async function startCursor(gmail: Gmail): Promise<Cursor> {
  const { historyId } = await gmail<{ historyId: string }>("/profile");
  const ids: string[] = [];
  let pageToken = "";
  do {
    const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(
      `/messages?q=${encodeURIComponent(START)}&maxResults=500${pageToken && `&pageToken=${pageToken}`}`,
    );
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken && ids.length < 2000);
  return { historyId: String(historyId), pending: ids.reverse() };
}

async function addMessage(
  itx: Pick<GoogleItx, "files" | "cd">,
  path: string,
  message: Message,
  gmail: Gmail,
): Promise<void> {
  const header = (name: string) =>
    message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
  const parts = flatten(message.payload);
  const attachments: { filename: string; contentType: string; size: number; path: string }[] = [];
  const taken = new Set<string>();
  for (const part of parts) {
    if (!part.filename) continue;
    const encoded = part.body?.attachmentId
      ? (
          await gmail<{ data?: string }>(
            `/messages/${message.id}/attachments/${part.body.attachmentId}`,
          )
        ).data
      : part.body?.data;
    if (!encoded) continue;
    const data = bytesOf(encoded);
    // one file per attachment, right under the message's folder
    const safe = part.filename.replace(/[\\/]/g, "_");
    let name = safe;
    for (let n = 2; taken.has(name); n++) name = safe.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    taken.add(name);
    const filePath = `${path}/${message.id}/${name}`;
    const contentType = part.mimeType || "application/octet-stream";
    await itx.files.get(filePath).put({ contentType, data });
    attachments.push({
      filename: part.filename,
      contentType,
      size: data.byteLength,
      path: filePath,
    });
  }
  const body = async (type: string) => {
    const part = parts.find((p) => p.mimeType === type && !p.filename && p.body?.data);
    if (!part) return null;
    const text = decode(bytesOf(part.body!.data!), part);
    if (text.length <= BODY_MAX_CHARS) return text;
    const filePath = `${path}/${message.id}/body.${type === "text/html" ? "html" : "txt"}`;
    await itx.files
      .get(filePath)
      .put({ contentType: `${type}; charset=utf-8`, data: new TextEncoder().encode(text) });
    return { path: filePath, chars: text.length };
  };
  await once(
    itx.cd(path).append({
      type: "gmail/message-added",
      // the message, once: a later sighting of it (other labels by then) adds nothing
      idempotencyKey: `gmail:${message.id}`,
      payload: {
        id: message.id,
        threadId: message.threadId,
        receivedAt: new Date(Number(message.internalDate)).toISOString(),
        labelIds: message.labelIds ?? [],
        from: header("from"),
        to: header("to"),
        cc: header("cc"),
        subject: header("subject"),
        date: header("date"),
        messageId: header("message-id"),
        snippet: message.snippet ?? "",
        text: await body("text/plain"),
        html: await body("text/html"),
        attachments,
      },
    }),
  );
}

const flatten = (part: Part | undefined): Part[] =>
  part ? [part, ...(part.parts ?? []).flatMap(flatten)] : [];

/** Base64, in either alphabet (Gmail's base64url, unpadded), as bytes. */
const bytesOf = (encoded: string): Uint8Array =>
  Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** A text part in its declared charset, UTF-8 when it names none the runtime knows. */
function decode(bytes: Uint8Array, part: Part): string {
  const type = part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  const charset = /charset="?([^";]+)"?/i.exec(type)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

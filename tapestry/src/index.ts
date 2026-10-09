import { ApiError, jsonResponse, object, pageSize, required } from "./http.js";
import type { Fetch, Json, JsonObject } from "./http.js";

import { parsePage, webConfig, type WebPage } from "./web.js";

export { ApiError };
export type { WebPage };
export type { Fetch, Json, JsonObject };

const ORIGIN = "https://www.tapestryjournal.com";
const APP_VERSION = "1.0.7";
export type School = JsonObject & { id: number; name?: string; furlSlug?: string };
export type Credentials = { access: string; refresh?: string; expiry?: number };
export type SchoolSession = {
  school: School;
  credentials: Credentials;
  expiresAt?: number;
};
export type TapestrySession = {
  deviceId: string;
  userAccessToken?: string;
  selectedSchool?: SchoolSession;
};
export type TapestryOptions = {
  session?: TapestrySession;
  fetch?: Fetch;
  timeoutMs?: number;
  now?: () => number;
  allowWrites?: boolean;
};
export type Query = Record<string, string | number | boolean | undefined>;
export type ObservationPage = {
  observations: JsonObject[];
  nextCursor?: string | null;
  prevCursor?: string | null;
};
export type ObservationOptions = {
  limit?: number;
  cursor?: string;
  search?: string;
  childId?: number;
  authorId?: number;
  hashtag?: string;
};
export type SchoolAuthentication = {
  school: School;
  credentials: Credentials;
  user?: JsonObject;
  [key: string]: unknown;
};
export type WebView =
  | "observations"
  | "memos"
  | "activities"
  | "messaging"
  | "notifications"
  | "care-diary";

const WEB_PATHS: Record<WebView, string> = {
  observations: "/v3/observations",
  memos: "/v3/memos",
  activities: "/v3/activities",
  messaging: "/v3/messaging",
  notifications: "/v3/notifications",
  "care-diary": "/v3/care-diary/relative",
};

function queryString(query: Query = {}): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) values.set(key, String(value));
  return values.size ? `?${values}` : "";
}
function safePath(path: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(path) || path.includes("//"))
    throw new Error("Expected a relative path without an origin, query or traversal");
}

function schoolId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("School ID must be a positive integer");
  return id;
}

function credentials(value: unknown): Credentials {
  if (!object(value) || typeof value.access !== "string" || !value.access)
    throw new ApiError("Tapestry", 200, "invalid-credentials-response");
  return {
    access: value.access,
    ...(typeof value.refresh === "string" ? { refresh: value.refresh } : {}),
    ...(typeof value.expiry === "number" && Number.isFinite(value.expiry) && value.expiry > 0
      ? { expiry: value.expiry }
      : {}),
  };
}

/** API v4 from Tapestry Education Platform. Responses keep the server's original fields. */
export class TapestryClient {
  #fetch: Fetch;
  #timeout: number;
  #now: () => number;
  #deviceId: string;
  #userAccessToken?: string;
  #school?: SchoolSession;
  #refreshing?: Promise<void>;
  #allowWrites: boolean;
  #web?: { school: SchoolSession; cookies: Map<string, string>; config: JsonObject; csrf: string };
  #bootstrapping?: Promise<void>;

  constructor(options: TapestryOptions = {}) {
    this.#allowWrites = options.allowWrites ?? false;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeout = options.timeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#deviceId = crypto.randomUUID();
    if (options.session) this.setSession(options.session);
  }

  setSession(session: TapestrySession): void {
    required(session.deviceId, "deviceId");
    if (session.selectedSchool) {
      schoolId(session.selectedSchool.school.id);
      credentials(session.selectedSchool.credentials);
      if (
        session.selectedSchool.expiresAt !== undefined &&
        !Number.isFinite(session.selectedSchool.expiresAt)
      )
        throw new Error("Invalid session expiry");
    }
    this.#web = undefined;
    this.#deviceId = session.deviceId;
    this.#userAccessToken = session.userAccessToken;
    this.#school = session.selectedSchool ? structuredClone(session.selectedSchool) : undefined;
  }

  getSession(): TapestrySession {
    return structuredClone({
      deviceId: this.#deviceId,
      userAccessToken: this.#userAccessToken,
      selectedSchool: this.#school,
    });
  }

  clearSession(): void {
    this.#web = undefined;
    this.#userAccessToken = undefined;
    this.#school = undefined;
  }

  /** Authenticate the account, then list its schools. Select one with authenticateSchool(). */
  async login(email: string, password: string): Promise<School[]> {
    const result = await this.#call("authenticate", "POST", undefined, {
      email: required(email, "email"),
      password: required(password, "password"),
    });
    if (!object(result)) throw new ApiError("Tapestry", 200, "invalid-login-response");
    const account = credentials(result.credentials);
    this.#web = undefined;
    this.#userAccessToken = account.access;
    this.#school = undefined;
    return this.getSchools();
  }

  async getSchools(): Promise<School[]> {
    const result = await this.#call("school-list", "GET", this.#accountToken());
    if (!object(result) || !Array.isArray(result.schools))
      throw new ApiError("Tapestry", 200, "invalid-school-list");
    for (const school of result.schools) {
      if (!object(school) || typeof school.id !== "number")
        throw new ApiError("Tapestry", 200, "invalid-school-list");
      schoolId(school.id);
    }
    return result.schools as School[];
  }

  /** MFA requirements are returned as ApiError.code. The account token remains available. */
  async authenticateSchool(id: number): Promise<SchoolAuthentication> {
    const result = await this.#call("authenticate-school", "POST", this.#accountToken(), {
      id: schoolId(id),
      appVersion: APP_VERSION,
    });
    const auth = this.#schoolAuthentication(result, id);
    this.#web = undefined;
    this.#school = this.#makeSchoolSession(auth);
    return auth;
  }

  getObservations(options: ObservationOptions = {}): Promise<ObservationPage> {
    return this.request("observations/list", {
      query: {
        perPage: pageSize(options.limit ?? 20),
        cursor: options.cursor,
        search: options.search,
        "children.child_id": options.childId,
        "observations.author": options.authorId,
        hashtag: options.hashtag,
      },
    });
  }

  async *observations(options: ObservationOptions = {}): AsyncGenerator<JsonObject, void, unknown> {
    let cursor = options.cursor;
    const seen = new Set<string>();
    if (cursor) seen.add(cursor);
    for (;;) {
      const page = await this.getObservations({ ...options, cursor });
      yield* page.observations;
      cursor = page.nextCursor ?? undefined;
      if (!cursor) return;
      if (seen.has(cursor)) throw new ApiError("Tapestry", 200, "repeated-page-cursor");
      seen.add(cursor);
    }
  }

  getNotifications(page = 1, limit = 20): Promise<JsonObject> {
    schoolId(page);
    return this.request("notifications/list", { query: { page, perPage: pageSize(limit) } });
  }

  getAnnouncements(
    options: { position?: "dropdown" | "toast"; onlyUnseen?: boolean } = {},
  ): Promise<JsonObject> {
    return this.request("announcements/list-announcements", {
      query: { position: options.position ?? "dropdown", onlyUnseen: options.onlyUnseen ? 1 : 0 },
    });
  }

  getNavigation(): Promise<JsonObject> {
    return this.request("navigation");
  }

  getThreads(options: ObservationOptions = {}): Promise<JsonObject> {
    return this.request("pages/threads-list", {
      query: {
        perPage: pageSize(options.limit ?? 20),
        cursor: options.cursor,
        search: options.search,
        "children.child_id": options.childId,
        authorId: options.authorId,
      },
    });
  }

  /** Mutations require allowWrites: true. They are never retried. */
  createObservation(input: JsonObject, draft = false): Promise<JsonObject> {
    return this.request(draft ? "observations/create-draft" : "observations/create", {
      method: "POST",
      body: input,
    });
  }
  updateObservation(input: JsonObject, draft = false): Promise<JsonObject> {
    return this.request(draft ? "observations/update-draft" : "observations/update", {
      method: "POST",
      body: input,
    });
  }
  addComment(pageId: number, comment: string): Promise<JsonObject> {
    return this.request("comment/add-comment", {
      method: "POST",
      body: { pageId: schoolId(pageId), comment: required(comment, "comment") },
    });
  }
  setLike(pageId: number, like: boolean): Promise<JsonObject> {
    return this.request("pages/set-likes", {
      method: "POST",
      body: { pageId: schoolId(pageId), like },
    });
  }

  async getConversations(): Promise<Json> {
    const userId = await this.#webUserId();
    return this.schoolRequest("messaging/conversations", { method: "POST", body: { userId } });
  }
  async getMessages(conversationId: number, cursor = ""): Promise<JsonObject> {
    const userId = await this.#webUserId();
    return this.schoolRequest("messaging/messages", {
      method: "POST",
      body: { userId, conversationId: schoolId(conversationId), cursor },
    });
  }
  getMessageRecipients(): Promise<Json> {
    return this.schoolRequest("messaging/users", { method: "POST", body: {} });
  }
  getMessagingSettings(): Promise<JsonObject> {
    return this.schoolRequest("messaging/frontend-data");
  }
  sendMessage(conversationId: number, messageContent: string): Promise<Json> {
    return this.schoolRequest("messaging/send-message", {
      method: "POST",
      body: {
        conversationId: schoolId(conversationId),
        messageContent: required(messageContent, "messageContent"),
      },
    });
  }
  async createConversation(otherParticipant: number): Promise<Json> {
    this.#checkWrite();
    const userId = await this.#webUserId();
    return this.schoolRequest("messaging/create-conversation", {
      method: "POST",
      body: { userId, otherParticipant: schoolId(otherParticipant) },
    });
  }

  /** These app screens use server-rendered HTML. The page includes the app's JSON bootstrap data. */
  getMemos(query: Query = {}): Promise<WebPage> {
    return this.getSchoolPage("memos", query);
  }
  getActivities(query: Query = {}): Promise<WebPage> {
    return this.getSchoolPage("activities", query);
  }
  getCareDiary(date: string): Promise<WebPage> {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new Error("Date must be a valid YYYY-MM-DD date");
    return this.getSchoolPage(`care-diary/relative/${date}`);
  }
  getAccountBalances(): Promise<WebPage> {
    return this.getSchoolPage("management/booking/relatives/account-balances");
  }

  getCurrentUser(): Promise<JsonObject> {
    return this.request("users/currentUser");
  }
  getChildren(): Promise<Json> {
    return this.request("children/list");
  }
  getUpdateCounts(): Promise<JsonObject> {
    return this.request("polling/list");
  }
  getObservationAuthors(): Promise<Json> {
    return this.request("observations/list-authors");
  }

  getObservation(id: number): Promise<JsonObject> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("Observation ID must be a positive integer");
    return this.request(`observations/get/${id}`);
  }

  /** Explicit mutation. Read calls never mark notifications as seen. */
  markNotificationSeen(notificationId: number): Promise<Json> {
    if (!Number.isSafeInteger(notificationId) || notificationId < 1)
      throw new Error("Notification ID must be a positive integer");
    return this.request("notifications/mark-seen", { method: "POST", body: { notificationId } });
  }

  /** A same-origin API v4 escape hatch for endpoints found in the signed-in web app. */
  async request<T = Json>(
    path: string,
    options: { method?: "GET" | "POST"; body?: Json; query?: Query } = {},
  ): Promise<T> {
    // Do not allow paths to escape /api/4, or send an access token to a supplied URL.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(path) || path.includes("//"))
      throw new Error("Expected an API v4 path, without an origin, query or traversal");
    const method = options.method ?? "GET";
    if (method === "GET" && options.body !== undefined)
      throw new Error("GET requests cannot have a body");
    if (method !== "GET" && path !== "users/list") this.#checkWrite();
    const selected = await this.#readySchool();
    const query = queryString(options.query);
    return (await this.#call(path + query, method, selected.credentials.access, options.body)) as T;
  }

  /** The APK loads these screens as HTML. This returns HTML, not a guessed JSON API. */
  async getWebView(view: WebView): Promise<string> {
    const selected = await this.#readySchool();
    const slug = selected.school.furlSlug;
    if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug))
      throw new Error("The school session has no valid furlSlug");
    const path = WEB_PATHS[view];
    if (!path) throw new Error("Unknown web view");
    const response = await this.#fetch(`${ORIGIN}/s/${slug}${path}`, {
      headers: { ...this.#webHeaders(selected), accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (!response.ok) throw new ApiError("Tapestry", response.status, "web-view-unavailable");
    if (!response.headers.get("content-type")?.includes("text/html"))
      throw new ApiError("Tapestry", response.status, "expected-html");
    return response.text();
  }

  /** School-scoped JSON endpoints from the embedded website. Uses its cookie and CSRF token. */
  async schoolRequest<T = Json>(
    path: string,
    options: { method?: "GET" | "POST"; body?: Json; query?: Query } = {},
  ): Promise<T> {
    safePath(path);
    const method = options.method ?? "GET";
    if (method === "GET" && options.body !== undefined)
      throw new Error("GET requests cannot have a body");
    if (
      method !== "GET" &&
      !["messaging/conversations", "messaging/messages", "messaging/users"].includes(path)
    )
      this.#checkWrite();
    await this.#ensureWeb();
    const response = await this.#schoolFetch(path, method, options.query, options.body);
    const data = await jsonResponse(response, "Tapestry");
    if (object(data) && (data.success === 0 || data.success === false || data.code === "CSRF")) {
      if (typeof data.newToken === "string" && this.#web) this.#web.csrf = data.newToken;
      throw new ApiError(
        "Tapestry",
        response.status,
        typeof data.code === "string" ? data.code : "web-api-error",
      );
    }
    return data as T;
  }

  async getSchoolPage(path: string, query?: Query): Promise<WebPage> {
    safePath(path);
    await this.#ensureWeb();
    const response = await this.#schoolFetch(path, "GET", query);
    if (!response.ok) throw new ApiError("Tapestry", response.status, "web-page-unavailable");
    if (!response.headers.get("content-type")?.includes("text/html"))
      throw new ApiError("Tapestry", response.status, "expected-html");
    return parsePage(await response.text());
  }

  #checkWrite(): void {
    if (!this.#allowWrites)
      throw new Error("Tapestry: writes are disabled; set allowWrites: true explicitly");
  }
  #slug(selected: SchoolSession): string {
    const slug = selected.school.furlSlug;
    if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug))
      throw new Error("The school session has no valid furlSlug");
    return slug;
  }
  #webHeaders(selected: SchoolSession): Record<string, string> {
    return {
      ...this.#headers(selected.credentials.access),
      "user-agent": `android TapestryAppWebView/${APP_VERSION}`,
    };
  }
  async #webUserId(): Promise<number> {
    await this.#ensureWeb();
    const user = this.#web!.config.authenticatedUser;
    if (!object(user) || typeof user.id !== "number")
      throw new ApiError("Tapestry", 200, "missing-web-user");
    return schoolId(user.id);
  }
  #cookies(response: Response, jar: Map<string, string>): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0],
        at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  async #ensureWeb(): Promise<void> {
    const selected = await this.#readySchool();
    if (this.#web?.school === selected) return;
    if (this.#bootstrapping) {
      await this.#bootstrapping;
      if (this.#web?.school === selected) return;
      throw new Error("Tapestry: session changed while loading website");
    }
    this.#bootstrapping = (async () => {
      const response = await this.#fetch(`${ORIGIN}/s/${this.#slug(selected)}/v3/observations`, {
        headers: { ...this.#webHeaders(selected), accept: "text/html" },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeout),
      });
      if (!response.ok) throw new ApiError("Tapestry", response.status, "web-session-unavailable");
      const config = webConfig(parsePage(await response.text()));
      if (this.#school !== selected)
        throw new Error("Tapestry: session changed while loading website");
      const cookies = new Map<string, string>();
      this.#cookies(response, cookies);
      this.#web = { school: selected, cookies, config, csrf: config.csrfToken as string };
    })();
    try {
      await this.#bootstrapping;
    } finally {
      this.#bootstrapping = undefined;
    }
  }
  async #schoolFetch(
    path: string,
    method: "GET" | "POST",
    query?: Query,
    body?: Json,
  ): Promise<Response> {
    const selected = await this.#readySchool();
    const web = this.#web;
    if (!web || web.school !== selected)
      throw new Error("Tapestry: web session changed; repeat the read");
    const response = await this.#fetch(
      `${ORIGIN}/s/${this.#slug(selected)}/${path}${queryString(query)}`,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeout),
        headers: {
          ...this.#webHeaders(selected),
          "content-type": "application/json",
          "X-TAPESTRY-VERSION": "3",
          "X-CSRF-TOKEN": web.csrf,
          cookie: Array.from(web.cookies, ([key, value]) => `${key}=${value}`).join("; "),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    this.#cookies(response, web.cookies);
    const csrf = response.headers.get("x-csrf-token");
    if (csrf) web.csrf = csrf;
    return response;
  }

  async refreshSession(): Promise<void> {
    const selected = this.#school;
    if (!selected?.credentials.refresh)
      throw new Error("Tapestry: school refresh token is missing; log in again");
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const result = await this.#call(
        "refresh-authenticate-school",
        "POST",
        selected.credentials.access,
        { refresh: selected.credentials.refresh! },
      );
      const auth = this.#schoolAuthentication(result, selected.school.id);
      if (this.#school !== selected)
        throw new Error("Tapestry: session changed during refresh; repeat the read");
      // Keep this object so waiting reads can use the new credentials.
      Object.assign(selected, this.#makeSchoolSession(auth));
    })();
    try {
      await this.#refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  async #readySchool(): Promise<SchoolSession> {
    const selected = this.#school;
    if (!selected) throw new Error("Tapestry: authenticate a school first");
    if (selected.expiresAt !== undefined && this.#now() >= selected.expiresAt - 60_000)
      await this.refreshSession();
    if (selected !== this.#school)
      throw new Error("Tapestry: session changed during request; repeat the read");
    return selected;
  }

  #schoolAuthentication(value: unknown, expectedId: number): SchoolAuthentication {
    if (!object(value) || !object(value.school) || value.school.id !== expectedId)
      throw new ApiError("Tapestry", 200, "school-mismatch");
    return {
      ...value,
      school: value.school as School,
      credentials: credentials(value.credentials),
    };
  }

  #makeSchoolSession(auth: SchoolAuthentication): SchoolSession {
    return {
      school: structuredClone(auth.school),
      credentials: { ...auth.credentials },
      expiresAt:
        auth.credentials.expiry === undefined
          ? undefined
          : this.#now() + auth.credentials.expiry * 1000,
    };
  }

  #accountToken(): string {
    if (!this.#userAccessToken) throw new Error("Tapestry: log in to the account first");
    return this.#userAccessToken;
  }

  #headers(token?: string): Record<string, string> {
    return {
      accept: "application/json",
      "user-agent": `android TapestryApp/${APP_VERSION}`,
      "X-Device-Id": this.#deviceId,
      ...(token ? { "X-Api-Key": token } : {}),
    };
  }

  async #call(path: string, method: string, token?: string, body?: Json): Promise<unknown> {
    const response = await this.#fetch(`${ORIGIN}/api/4/${path}`, {
      method,
      headers: {
        ...this.#headers(token),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (response.status === 204) return null;
    return jsonResponse(response, "Tapestry");
  }
}

export default TapestryClient;

import { ApiError, jsonResponse, object, pageSize, required } from "./http.js";
import type { Fetch, Json, JsonObject } from "./http.js";
import { OPERATIONS } from "./operations.js";

export { ApiError, OPERATIONS };
export type { Fetch, Json, JsonObject };

const ORIGIN = "https://app.seesaw.me";
const GRAPHQL_URL = "https://reloaded-api.seesaw.me/ss2_gql";
const RELEASE = "prod-ca332f0deddb910eb64ec3b8f0b905a790ae871d";

export type SeesawSession = { accessToken: string; personId?: string };
export type SeesawOptions = {
  session?: SeesawSession;
  fetch?: Fetch;
  timeoutMs?: number;
  allowWrites?: boolean;
};
export type LoginOptions = { twoFactorCode?: string; captchaResponse?: string };
export type JournalOptions = { limit?: number; startKey?: string };
export type JournalPage = {
  items: { objects: JsonObject[]; last_key?: string | null };
  [key: string]: unknown;
};
export type ParentInfo = {
  children: { objects: (JsonObject & { person_id: string })[] };
  [key: string]: unknown;
};
export type Connection<T> = {
  edges: T[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};
export type Conversation = JsonObject & { id: string; label?: string | null };
export type Message = JsonObject & { id: string; content?: string | null };

export class SeesawChallengeError extends Error {
  readonly challenge: "two-factor" | "captcha";
  readonly method?: string;
  readonly redactedEmail?: string;

  constructor(challenge: "two-factor" | "captcha", response: JsonObject) {
    super(`Seesaw requires ${challenge}; complete the challenge and call login again`);
    this.name = "SeesawChallengeError";
    this.challenge = challenge;
    this.method =
      typeof response.two_factor_authentication_method === "string"
        ? response.two_factor_authentication_method
        : undefined;
    this.redactedEmail =
      typeof response.redacted_email === "string" ? response.redacted_email : undefined;
  }
}

/** Parent account API. No browser, password storage, background polling or automatic writes. */
export class SeesawClient {
  #session?: SeesawSession;
  #fetch: Fetch;
  #timeout: number;
  #allowWrites: boolean;

  constructor(options: SeesawOptions = {}) {
    this.#allowWrites = options.allowWrites ?? false;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeout = options.timeoutMs ?? 30_000;
    if (options.session) this.setSession(options.session);
  }

  setSession(session: SeesawSession): void {
    this.#session = { ...session, accessToken: required(session.accessToken, "accessToken") };
  }

  getSession(): SeesawSession | undefined {
    return this.#session ? { ...this.#session } : undefined;
  }

  clearSession(): void {
    this.#session = undefined;
  }

  async login(email: string, password: string, options: LoginOptions = {}): Promise<SeesawSession> {
    const result = await this.#rest<JsonObject>(
      "/api/auth/login",
      "POST",
      {
        email: required(email, "email"),
        password: required(password, "password"),
        role: "parent",
        classes: true,
        two_factor_authentication_code: options.twoFactorCode,
        g_recaptcha_response: options.captchaResponse,
      },
      false,
    );
    if (result.two_factor_authentication_required)
      throw new SeesawChallengeError("two-factor", result);
    if (result.recaptcha_required) throw new SeesawChallengeError("captcha", result);
    if (
      typeof result.user_token !== "string" ||
      !object(result.person) ||
      typeof result.person.person_id !== "string"
    )
      throw new ApiError("Seesaw", 200, "invalid-login-response");
    const session = { accessToken: result.user_token, personId: result.person.person_id };
    this.setSession(session);
    return session;
  }

  getParent(): Promise<ParentInfo> {
    return this.#rest("/api/person/parent/info");
  }
  getDashboard(): Promise<JsonObject> {
    return this.#rest("/api/person/parent/dashboard_v3");
  }

  async getChildren(): Promise<ParentInfo["children"]["objects"]> {
    return (await this.getParent()).children.objects;
  }

  async getChildClasses(childId: string): Promise<JsonObject[]> {
    const result = await this.#rest<{ objects: JsonObject[] }>(
      "/api/person/parent/child_classes",
      "GET",
      { child_id: required(childId, "childId") },
    );
    return result.objects;
  }

  getJournal(options: JournalOptions = {}): Promise<JournalPage> {
    return this.#rest("/api/person/parent/feed", "GET", {
      limit: pageSize(options.limit ?? 8),
      start_key: options.startKey,
    });
  }

  getClassJournal(
    childId: string,
    classId: string,
    options: JournalOptions & { folderId?: string } = {},
  ): Promise<JournalPage> {
    return this.#rest("/api/person/parent/class_feed", "GET", {
      child_id: required(childId, "childId"),
      class_id: required(classId, "classId"),
      limit: pageSize(options.limit ?? 8),
      start_key: options.startKey,
      folder_id: options.folderId,
    });
  }

  async *journal(options: JournalOptions = {}): AsyncGenerator<JsonObject, void, unknown> {
    let key = options.startKey;
    const seen = new Set<string>();
    if (key) seen.add(key);
    for (;;) {
      const page = await this.getJournal({ ...options, startKey: key });
      yield* page.items.objects;
      key = page.items.last_key ?? undefined;
      if (!key) return;
      if (seen.has(key)) throw new ApiError("Seesaw", 200, "repeated-page-cursor");
      seen.add(key);
    }
  }

  getItem(itemId: string): Promise<JsonObject> {
    return this.#rest("/api/item_v2", "GET", { item_id: required(itemId, "itemId") });
  }

  /** School permissions can restrict this endpoint to student or teacher accounts. */
  getActivities(
    classId: string,
    options: { states: string[]; startKey?: string; studentId?: string },
  ): Promise<JsonObject> {
    if (!options.states.length) throw new Error("At least one activity state is required");
    return this.#rest("/api/prompt/feed", "GET", {
      class_id: required(classId, "classId"),
      prompt_states: options.states.join(","),
      start_key: options.startKey,
      user_id: options.studentId,
    });
  }

  getActivity(
    promptId: string,
    options: { classId?: string; studentId?: string } = {},
  ): Promise<JsonObject> {
    return this.#rest("/api/prompt", "GET", {
      prompt_id: required(promptId, "promptId"),
      classId: options.classId,
      user_id: options.studentId,
      load_recurrence: true,
    });
  }

  addComment(itemId: string, comment: string, classId?: string): Promise<JsonObject> {
    this.#checkWrite();
    return this.#rest("/api/item/add_comment", "POST", {
      item_id: required(itemId, "itemId"),
      comment_text: required(comment, "comment"),
      user_id: required(this.#session?.personId ?? "", "personId"),
      class_id: classId,
    });
  }
  setLike(itemId: string, liked: boolean): Promise<JsonObject> {
    this.#checkWrite();
    return this.#rest(liked ? "/api/item/add_like" : "/api/item/remove_like", "POST", {
      item_id: required(itemId, "itemId"),
      user_id: required(this.#session?.personId ?? "", "personId"),
    });
  }

  getNotifications(startKey?: string): Promise<JsonObject> {
    return this.#rest("/api/person/parent/notifications", "GET", {
      start_key: startKey,
      clear_unread_count: false,
    });
  }

  async getConversations(
    options: { cursor?: string; searchText?: string; hidden?: boolean } = {},
  ): Promise<Connection<{ conversation: Conversation }>> {
    const result = await this.graphql<{
      conversationsSearch: { conversationsConnection: Connection<{ conversation: Conversation }> };
    }>(OPERATIONS.conversations, {
      cursor: options.cursor ?? null,
      searchText: options.searchText ?? null,
      isHidden: options.hidden ?? false,
    });
    return result.conversationsSearch.conversationsConnection;
  }

  async getMessages(
    conversationId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<Connection<{ message: Message }>> {
    const result = await this.graphql<{
      conversation: { conversation: { messagesConnection: Connection<{ message: Message }> } };
    }>(OPERATIONS.messages, {
      conversationId: required(conversationId, "conversationId"),
      cursor: options.cursor ?? null,
      limit: pageSize(options.limit ?? 20),
    });
    return result.conversation.conversation.messagesConnection;
  }

  /** Sends once. After a network failure, read the conversation before deciding to resend. */
  async sendMessage(
    conversationId: string,
    content: string,
    tempId: string = crypto.randomUUID(),
  ): Promise<{ messageId: string; tempId: string }> {
    this.#checkWrite();
    const result = await this.graphql<{ sendMessage: { messageId: string; tempId: string } }>(
      OPERATIONS.sendMessage,
      {
        conversationId: required(conversationId, "conversationId"),
        content: required(content, "content"),
        tempId: required(tempId, "tempId"),
      },
    );
    return result.sendMessage;
  }

  async graphql<T = JsonObject>(query: string, variables: Record<string, Json> = {}): Promise<T> {
    // The unrestricted GraphQL escape hatch needs write opt-in for mutations.
    if (!/^(?:\s|#[^\n]*(?:\n|$))*(?:query\b|\{)/.test(query)) this.#checkWrite();
    const response = await this.#fetch(GRAPHQL_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeout),
      headers: { ...this.#headers(true), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = await jsonResponse(response, "Seesaw");
    if (!object(body)) throw new ApiError("Seesaw", response.status, "invalid-response");
    if (Array.isArray(body.errors) && body.errors.length)
      throw new ApiError("Seesaw", response.status, "graphql-error");
    if (!object(body.data)) throw new ApiError("Seesaw", response.status, "missing-data");
    for (const value of Object.values(body.data)) {
      if (object(value) && typeof value.errorCode === "string")
        throw new ApiError("Seesaw", response.status, value.errorCode);
    }
    return body.data as T;
  }

  #checkWrite(): void {
    if (!this.#allowWrites)
      throw new Error("Seesaw: writes are disabled; set allowWrites: true explicitly");
  }

  #headers(auth: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "Seesaw/10.146.0 (Android)",
    };
    if (auth) {
      if (!this.#session) throw new Error("Seesaw: login or provide a session first");
      headers.authorization = `Bearer ${this.#session.accessToken}`;
    }
    return headers;
  }

  async #rest<T = JsonObject>(
    path: string,
    method = "GET",
    params: Record<string, string | number | boolean | undefined> = {},
    auth = true,
  ): Promise<T> {
    const values = new URLSearchParams({
      _release: RELEASE,
      _tz_offset: String(-new Date().getTimezoneOffset() * 60),
    });
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) values.set(key, String(value));
    const headers = this.#headers(auth);
    if (method === "POST")
      headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    const response = await this.#fetch(`${ORIGIN}${path}${method === "GET" ? `?${values}` : ""}`, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeout),
      ...(method === "POST" ? { body: values.toString() } : {}),
    });
    const body = await jsonResponse(response, "Seesaw");
    if (!object(body)) throw new ApiError("Seesaw", response.status, "invalid-response");
    if (body.status !== "OK") {
      const code = object(body.error_dict) ? body.error_dict.error_code : undefined;
      throw new ApiError(
        "Seesaw",
        response.status,
        typeof code === "number" || typeof code === "string" ? code : "api-error",
      );
    }
    if (!object(body.response)) throw new ApiError("Seesaw", response.status, "missing-response");
    return body.response as T;
  }
}

export default SeesawClient;

import { load } from "cheerio/slim";
import type { CheerioAPI } from "cheerio/slim";

const ORIGIN = "https://www.amazon.co.uk";
export type WebFetch = (request: Request) => Promise<Response>;
export type BasketItem = {
  id: string;
  asin: string;
  title: string;
  quantity: number;
  selected: boolean;
  unitPricePence: number | null;
};
export type CheckoutField = { name: string; choices?: { value: string; label: string }[] };
export type Checkout = {
  id: string;
  stage: string;
  summary: string;
  totalPence: number | null;
  currency: "GBP";
  readyToOrder: boolean;
  forms: { id: number; purpose: string; fields: CheckoutField[] }[];
};
type Document = { url: string; html: string; $: CheerioAPI; headers: Headers; csrfToken?: string };
type Form = { action: string; method: string; data: URLSearchParams; fields: CheckoutField[] };

export class AmazonWebError extends Error {
  readonly code: string;
  readonly outcomeUnknown: boolean;
  constructor(code: string, outcomeUnknown: boolean = false) {
    super(
      `amazon: ${code}${outcomeUnknown ? "; check Amazon orders before any new purchase" : ""}`,
    );
    this.name = "AmazonWebError";
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function amazonUrl(value: string, base: string = ORIGIN): URL {
  const url = new URL(value, base);
  if (url.origin !== ORIGIN || url.username || url.password)
    throw new AmazonWebError("unexpected_origin");
  return url;
}
function integer(value: number, min = 1): void {
  if (!Number.isSafeInteger(value) || value < min || value > 999)
    throw new AmazonWebError("invalid_quantity");
}
function asinOf(value: string): string {
  const asin = /^[A-Z0-9]{10}$/i.test(value)
    ? value
    : /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(amazonUrl(value).pathname)?.[1];
  if (!asin) throw new AmazonWebError("invalid_asin");
  return asin.toUpperCase();
}
function pence(value: string): number | null {
  const match = /^(?:£)?([0-9,]+)\.([0-9]{2})$/.exec(value.trim());
  if (!match) return null;
  const result = Number(match[1]!.replaceAll(",", "")) * 100 + Number(match[2]);
  return Number.isSafeInteger(result) ? result : null;
}
function summary($: CheerioAPI): string {
  const copy = load($.html());
  copy("script,style,nav,header,footer,input,select,textarea,[hidden],.a-popover-preload").remove();
  return copy("body").text().replace(/\s+/g, " ").trim();
}
function forms(doc: Document, selector: string): Form[] {
  const $ = doc.$;
  return $(selector)
    .map((_, element) => {
      const form = $(element);
      const data = new URLSearchParams();
      const fields: CheckoutField[] = [];
      form.find("input[name],select[name],textarea[name]").each((_, input) => {
        const el = $(input);
        if (el.closest("form").get(0) !== element || el.is(":disabled")) return;
        const name = el.attr("name")!;
        if (!name) return;
        const type = el.attr("type") ?? "text";
        if (["submit", "button", "image"].includes(type)) return;
        if (type === "hidden") {
          data.append(name, el.attr("value") ?? "");
          return;
        }
        let field = fields.find((f) => f.name === name);
        if (!field) {
          field = { name };
          fields.push(field);
        }
        if (type === "radio" || type === "checkbox") {
          const value = el.attr("value") ?? "on";
          (field.choices ??= []).push({
            value,
            label: el.closest("label").text().replace(/\s+/g, " ").trim() || value,
          });
          if (el.is(":checked")) data.append(name, value);
        } else if (input.type === "tag" && input.name === "select") {
          field.choices = el
            .find("option")
            .map((_, option) => ({
              value: $(option).attr("value") ?? "",
              label: $(option).text().trim(),
            }))
            .get();
          const value = el.val();
          if (typeof value === "string") data.append(name, value);
        } else data.append(name, el.val()?.toString() ?? "");
      });
      return {
        action: amazonUrl(form.attr("action") ?? doc.url, doc.url).href,
        method: (form.attr("method") ?? "get").toUpperCase(),
        data,
        fields,
      };
    })
    .get();
}

/** Amazon's observed website protocol. Cookies belong to the supplied transport. */
export class AmazonWebApi {
  readonly #fetch: WebFetch;
  readonly #maxOrderPence?: number;
  #checkout?: { view: Checkout; doc: Document; forms: Form[]; orderForm?: Form };
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { fetch: WebFetch; maxOrderPence?: number }) {
    this.#fetch = options.fetch;
    if (
      options.maxOrderPence !== undefined &&
      (!Number.isSafeInteger(options.maxOrderPence) || options.maxOrderPence < 1)
    )
      throw new AmazonWebError("invalid_order_cap");
    this.#maxOrderPence = options.maxOrderPence;
  }
  __describe(): { provider: string; instructions: string; functions: string[] } {
    return {
      provider: "Amazon UK website HTTP protocol (experimental)",
      instructions:
        "Search and basket methods use direct HTTP after Chrome login. startCheckout returns saved addresses and forms; continueCheckout submits a displayed form with visible field values only. Read the full checkout summary. placeOrder requires its current checkout ID and exact GBP total in pence; purchases require an owner-configured cap. No automatic purchase retries. A person handles login challenges. Website endpoints are not a documented public Amazon API.",
      functions: [
        "searchProducts",
        "getProduct",
        "getBasket",
        "addToBasket",
        "setQuantity",
        "selectBasketItem",
        "removeFromBasket",
        "startCheckout",
        "getCheckout",
        "continueCheckout",
        "placeOrder",
      ],
    };
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async #request(
    value: string,
    init: RequestInit = {},
    ordering = false,
    baseDoc?: Document,
  ): Promise<Document> {
    let url = amazonUrl(value);
    const headers = new Headers(init.headers);
    if (url.pathname.startsWith("/checkout/p/") && baseDoc) {
      const csrf =
        baseDoc.$("meta[name='anti-csrftoken-a2z']").first().attr("content") ??
        baseDoc.$("input[name='anti-csrftoken-a2z']").first().attr("value") ??
        baseDoc.csrfToken;
      if (!csrf) throw new AmazonWebError("missing_checkout_token");
      headers.set("anti-csrftoken-a2z", csrf);
      headers.set("x-requested-with", "XMLHttpRequest");
      headers.set("x-amz-checkout-transition", "ajax");
      headers.set("x-amz-checkout-type", "spp");
      headers.set("accept", "text/plain, */*; q=0.01");
      headers.set("referer", baseDoc.url);
    }
    let method = init.method ?? "GET";
    let body = init.body;
    let submitted = false;
    for (let redirects = 0; redirects < 8; redirects++) {
      let response: Response;
      try {
        submitted ||= ordering && method === "POST";
        response = await this.#fetch(
          new Request(url, { ...init, headers, method, body, redirect: "manual" }),
        );
      } catch {
        throw new AmazonWebError("transport_failed", submitted);
      }
      if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
        try {
          url = amazonUrl(response.headers.get("location")!, url.href);
        } catch {
          throw new AmazonWebError("unexpected_origin", submitted);
        }
        if ([301, 302, 303].includes(response.status)) {
          method = "GET";
          body = undefined;
        } else if (submitted) throw new AmazonWebError("unexpected_order_redirect", true);
        continue;
      }
      let html: string;
      try {
        html = await response.text();
      } catch {
        throw new AmazonWebError("response_lost", submitted);
      }
      if (
        /\/ap\/(?:signin|cvf|mfa)|\/errors\/validateCaptcha/.test(url.pathname) ||
        /id=["'](?:captchacharacters|auth-mfa-otpcode|ap_password)["']/.test(html)
      )
        throw new AmazonWebError("human_login_required", submitted);
      if (!response.ok) throw new AmazonWebError(`http_${response.status}`, submitted);
      let parsed = load(html);
      if (
        response.headers.get("content-type")?.includes("application/json") &&
        html.trim().startsWith("{")
      ) {
        let json: { panels?: { id: string; content: string }[] };
        try {
          json = JSON.parse(html) as typeof json;
        } catch {
          throw new AmazonWebError("invalid_response", submitted);
        }
        if (Array.isArray(json.panels)) {
          parsed = load(baseDoc?.html ?? "<html><body></body></html>");
          for (const panel of json.panels) {
            if (!/^[a-zA-Z0-9_-]+$/.test(panel.id) || typeof panel.content !== "string")
              throw new AmazonWebError("invalid_checkout_panel", submitted);
            const target = parsed(`[id="${panel.id}"]`);
            if (target.length) target.html(panel.content);
            else parsed("body").append(`<section id="${panel.id}">${panel.content}</section>`);
          }
          html = parsed.html();
        }
      }
      return {
        url: url.href,
        html,
        $: parsed,
        headers: response.headers,
        csrfToken: headers.get("anti-csrftoken-a2z") ?? undefined,
      };
    }
    throw new AmazonWebError("too_many_redirects", submitted);
  }
  async #submit(doc: Document, form: Form, ordering = false): Promise<Document> {
    if (form.method === "GET") {
      const url = amazonUrl(form.action);
      for (const [key, value] of form.data) url.searchParams.append(key, value);
      return this.#request(url.href);
    }
    if (form.method !== "POST") throw new AmazonWebError("unsupported_form_method");
    if (new URL(form.action).pathname.startsWith("/checkout/p/")) {
      form.data.set("hasWorkingJavascript", "1");
      form.data.set("isAsync", "1");
      form.data.set("isClientTimeBased", "1");
    }
    return this.#request(
      form.action,
      {
        method: "POST",
        body: form.data.toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          referer: doc.url,
        },
      },
      ordering,
      doc,
    );
  }
  async searchProducts(
    query: string,
    options: { page?: number } = {},
  ): Promise<{
    results: { asin: string; title: string; url: string; price: string; sponsored: boolean }[];
  }> {
    if (typeof query !== "string" || !query.trim()) throw new AmazonWebError("empty_query");
    const page = options.page ?? 1;
    integer(page);
    const doc = await this.#request(
      `/s?${new URLSearchParams({ k: query, page: String(page) }).toString()}`,
    );
    const $ = doc.$;
    const results = $('[data-component-type="s-search-result"][data-asin]')
      .map((_, el) => {
        const row = $(el);
        const asin = row.attr("data-asin")!;
        return {
          asin,
          title: row.find("h2").first().text().trim(),
          url: `${ORIGIN}/dp/${asin}`,
          price: row.find(".a-price .a-offscreen").first().text().trim(),
          sponsored: /Sponsored/.test(row.text()),
        };
      })
      .get()
      .filter((p) => /^[A-Z0-9]{10}$/.test(p.asin) && p.title);
    if (!results.length && !/No results|did not match/i.test(doc.html))
      throw new AmazonWebError("search_markup_changed");
    return { results };
  }
  async getProduct(
    value: string,
  ): Promise<{ asin: string; title: string; price: string; canAddToBasket: boolean }> {
    const asin = asinOf(value);
    const doc = await this.#request(`/dp/${asin}`);
    return {
      asin,
      title: doc.$("#productTitle").text().trim(),
      price: doc
        .$("#corePriceDisplay_desktop_feature_div .a-offscreen,#corePrice_feature_div .a-offscreen")
        .first()
        .text()
        .trim(),
      canAddToBasket: !!doc.$("#addToCart #add-to-cart-button").length,
    };
  }
  async #basket(): Promise<{ doc: Document; items: BasketItem[] }> {
    const doc = await this.#request("/gp/cart/view.html");
    const $ = doc.$;
    const items = $("#activeCartViewForm [data-itemid][data-asin]")
      .map((_, el) => {
        const row = $(el);
        return {
          id: row.attr("data-itemid")!,
          asin: row.attr("data-asin")!,
          title: row.attr("data-producttitle") ?? row.find(".sc-product-title").text().trim(),
          quantity: Number(row.attr("data-quantity")),
          selected: row.attr("data-isselected") === "1",
          unitPricePence: pence(row.attr("data-price") ?? ""),
        };
      })
      .get();
    if (!$("#activeCartViewForm").length && !/basket is empty|cart is empty/i.test(doc.html))
      throw new AmazonWebError("basket_markup_changed");
    return { doc, items };
  }
  getBasket(): Promise<BasketItem[]> {
    return this.#serial(async () => (await this.#basket()).items);
  }
  addToBasket(value: string, quantity: number = 1): Promise<BasketItem[]> {
    const asin = asinOf(value);
    integer(quantity);
    return this.#serial(async () => {
      this.#checkout = undefined;
      const doc = await this.#request(`/dp/${asin}`);
      const form = forms(doc, "#addToCart")[0];
      if (!form || !doc.$("#add-to-cart-button").length || !form.data.has("anti-csrftoken-a2z"))
        throw new AmazonWebError("offer_unavailable");
      form.action = `${ORIGIN}/cart/add-to-cart`;
      form.method = "POST";
      form.data.set("quantity", String(quantity));
      form.data.set("items[0.base][quantity]", String(quantity));
      form.data.set("isBuyNow", "0");
      form.data.set("submit.add-to-cart", "Add to basket");
      await this.#submit(doc, form);
      return (await this.#basket()).items;
    });
  }
  #change(
    id: string,
    type: string,
    patch: Record<string, string | number | boolean>,
  ): Promise<BasketItem[]> {
    return this.#serial(async () => {
      this.#checkout = undefined;
      const { doc, items } = await this.#basket();
      const item = items.find((i) => i.id === id);
      if (!item) throw new AmazonWebError("basket_item_not_found");
      const $ = doc.$;
      const row = $("[data-itemid]")
        .filter((_, el) => $(el).attr("data-itemid") === id)
        .first();
      const csrf =
        $("meta[name='anti-csrftoken-a2z']").first().attr("content") ??
        $("#activeCartViewForm input[name='anti-csrftoken-a2z']").val()?.toString();
      if (!csrf) throw new AmazonWebError("missing_basket_token");
      const activeItems = $("#activeCartViewForm [data-itemid][data-asin]")
        .map((_, el) => {
          const r = $(el);
          return {
            itemId: r.attr("id"),
            giftable: Number(r.attr("data-giftable") ?? 0),
            giftWrapped: Number(r.attr("data-giftwrapped") ?? 0),
            quantity: Number(r.attr("data-quantity")),
            price: Number(r.attr("data-price")),
            incentivizedCartMessage: r.attr("data-incentivizedcartmessage") ?? "",
            nestedItemsQuantity: 0,
            installments: [],
            isSelected: Number(r.attr("data-isselected")),
            unifiedDeliveryMessage: r.attr("data-unifieddeliverymessage") ?? "",
            showLineLevelRecommender: Number(r.attr("data-showlinelevelrecommender") ?? 0),
            exceedsSimplificationThreshold: 0,
            relatedItemIds: [],
          };
        })
        .get();
      const body = new URLSearchParams({
        "submit.cart-actions": "1",
        pageAction: "cart-actions",
        actionPayload: JSON.stringify([
          {
            type,
            payload: {
              itemId: id,
              list: "activeItems",
              relatedItemIds: [],
              isPrimeAsin: row.attr("data-isprimeasin") === "1",
              ...patch,
            },
          },
        ]),
        hasMoreItems: "false",
        addressId: "",
        addressZip: "",
        displayedSavedItemNum: "0",
        activeItems: JSON.stringify(activeItems),
        savedItems: "[]",
      });
      await this.#request("/cart/ref=ox_sc_cart_actions_1", {
        method: "POST",
        body: body.toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
          "x-aui-view": "Desktop",
          "anti-csrftoken-a2z": csrf,
          referer: doc.url,
          origin: ORIGIN,
        },
      });
      return (await this.#basket()).items;
    });
  }
  setQuantity(id: string, quantity: number): Promise<BasketItem[]> {
    integer(quantity);
    return this.#change(id, "UPDATE_QUANTITY_START", { quantity });
  }
  selectBasketItem(id: string, selected: boolean): Promise<BasketItem[]> {
    if (typeof selected !== "boolean") throw new AmazonWebError("invalid_selection");
    return this.#change(id, "UPDATE_ITEM_SELECTION_START", { isSelected: selected });
  }
  removeFromBasket(id: string): Promise<BasketItem[]> {
    return this.#change(id, "DELETE_START", {});
  }
  #saveCheckout(doc: Document): Checkout {
    const all = forms(doc, "form[action*='/checkout/p/']");
    const orderForm = all.find((f) => /\/spc\/place-order(?:\?|$)/.test(f.action));
    const steps = all
      .filter(
        (f) =>
          !f.action.includes("place-order") &&
          /\/(?:business-address\/continue|set\/ship-to-multi|payselect\/[^?]*continue)(?:\?|$)/.test(
            f.action,
          ),
      )
      .sort(
        (a, b) =>
          Number(new URL(b.action).searchParams.get("requestedViewType") === "spc") -
          Number(new URL(a.action).searchParams.get("requestedViewType") === "spc"),
      );
    const totals = doc
      .$(".order-summary-grid")
      .filter((_, el) =>
        doc.$(el).find(".order-summary-line-term").text().trim().startsWith("Order Total:"),
      )
      .map((_, el) => pence(doc.$(el).find('[data-shimmer-target="ordertotals-amount"]').text()))
      .get()
      .filter((v): v is number => v !== null);
    const totalPence = totals.length && totals.every((v) => v === totals[0]) ? totals[0]! : null;
    const view: Checkout = {
      id: crypto.randomUUID(),
      stage: orderForm
        ? "review"
        : steps.some((f) => f.action.includes("business-address"))
          ? "address"
          : steps.some((f) => f.action.includes("ship-to-multi"))
            ? "items"
            : new URL(doc.url).pathname.split("/").at(-1)!,
      summary: summary(doc.$),
      totalPence,
      currency: "GBP",
      readyToOrder: !!orderForm,
      forms: steps.map((f, id) => ({
        id,
        purpose:
          new URL(f.action).searchParams.get("requestedViewType") ??
          new URL(f.action).pathname.split("/").slice(-2).join("/"),
        fields: f.fields,
      })),
    };
    const purchasePath = /^(\/checkout\/p\/[^/]+)/.exec(
      new URL((orderForm ?? steps[0])?.action ?? doc.url).pathname,
    )?.[1];
    if (purchasePath && ["review", "address", "items"].includes(view.stage)) {
      const canonical = amazonUrl((orderForm ?? steps[0])!.action);
      canonical.pathname = `${purchasePath}/${view.stage === "review" ? "spc" : view.stage === "items" ? "itemselect" : "address"}`;
      doc = { ...doc, url: canonical.href };
    }
    this.#checkout = { view, doc, forms: steps, orderForm };
    return structuredClone(view);
  }
  startCheckout(): Promise<Checkout> {
    return this.#serial(async () => {
      const { doc, items } = await this.#basket();
      const form = forms(doc, "#gutterCartViewForm")[0];
      if (!form) throw new AmazonWebError("checkout_entry_unavailable");
      if (!items.some((i) => i.selected)) throw new AmazonWebError("no_selected_items");
      form.data.set("partialCheckoutCart", "1");
      form.data.set("cartItemCount", String(items.filter((i) => i.selected).length));
      // Chrome starts a fresh purchase view before checkout. Reusing the old view can
      // include items which the buyer has since deselected.
      const preinit = await this.#request(
        `/checkout/entry/cart?${new URLSearchParams({ isPreinit: "1", partialCheckoutCart: "1", pipelineType: form.data.get("pipelineType") ?? "Chewbacca", referrer: "cart", isEligibilityLogicDisabled: "1", cartItemCount: String(items.filter((i) => i.selected).length) }).toString()}`,
      );
      if (preinit.$("form[action*='/checkout/p/']").length) return this.#saveCheckout(preinit);
      const executionId = preinit.headers.get("x-amz-checkout-executionid");
      if (executionId) form.data.set("preInitiateExecutionId", executionId);
      let next = await this.#submit(doc, form);
      if (new URL(next.url).pathname.startsWith("/checkout/byg")) {
        const href = next.$("a[href*='/checkout/entry/cart']").first().attr("href");
        if (!href) throw new AmazonWebError("checkout_entry_markup_changed");
        next = await this.#request(amazonUrl(href, next.url).href);
      }
      return this.#saveCheckout(next);
    });
  }
  getCheckout(
    options: { step?: "address" | "payment" | "items" | "review" } = {},
  ): Promise<Checkout> {
    return this.#serial(async () => {
      if (!this.#checkout) throw new AmazonWebError("start_checkout_first");
      let url = this.#checkout.doc.url;
      if (options.step) {
        const path = /^(\/checkout\/p\/[^/]+)/.exec(new URL(url).pathname)?.[1];
        const routes = { address: "address", payment: "pay", items: "itemselect", review: "spc" };
        if (!path || !Object.hasOwn(routes, options.step))
          throw new AmazonWebError("unsupported_checkout_step");
        const step = options.step;
        if (step !== "review") {
          const href = this.#checkout.doc
            .$("a[href]")
            .map((_, el) => this.#checkout!.doc.$(el).attr("href"))
            .get()
            .find((value) => {
              try {
                return amazonUrl(value, url).pathname === `${path}/${routes[step]}`;
              } catch {
                return false;
              }
            });
          if (!href) throw new AmazonWebError("unsupported_checkout_step");
          url = amazonUrl(href, url).href;
        } else {
          const target = amazonUrl(url);
          target.pathname = `${path}/spc`;
          url = target.href;
        }
      }
      return this.#saveCheckout(await this.#request(url, {}, false, this.#checkout.doc));
    });
  }
  continueCheckout(input: {
    checkoutId: string;
    formId: number;
    values?: Record<string, string>;
  }): Promise<Checkout> {
    return this.#serial(async () => {
      const saved = this.#checkout;
      if (!saved || saved.view.id !== input.checkoutId) throw new AmazonWebError("stale_checkout");
      const original = saved.forms[input.formId];
      if (!original) throw new AmazonWebError("unknown_checkout_form");
      const form = { ...original, data: new URLSearchParams(original.data) };
      for (const [key, value] of Object.entries(input.values ?? {})) {
        const field = form.fields.find((f) => f.name === key);
        if (
          !field ||
          typeof value !== "string" ||
          (field.choices && !field.choices.some((c) => c.value === value))
        )
          throw new AmazonWebError("invalid_checkout_field");
        form.data.set(key, value);
      }
      this.#checkout = undefined;
      return this.#saveCheckout(await this.#submit(saved.doc, form));
    });
  }
  placeOrder(input: {
    checkoutId: string;
    expectedTotalPence: number;
  }): Promise<{ outcome: "submitted"; summary: string }> {
    return this.#serial(async () => {
      if (!this.#maxOrderPence) throw new AmazonWebError("purchases_disabled");
      const saved = this.#checkout;
      if (!saved || saved.view.id !== input.checkoutId || !saved.orderForm)
        throw new AmazonWebError("stale_or_incomplete_checkout");
      if (
        !Number.isSafeInteger(input.expectedTotalPence) ||
        input.expectedTotalPence < 1 ||
        input.expectedTotalPence > this.#maxOrderPence ||
        input.expectedTotalPence !== saved.view.totalPence
      )
        throw new AmazonWebError("order_total_mismatch");
      const fresh = await this.#request(saved.doc.url, {}, false, saved.doc);
      const view = this.#saveCheckout(fresh);
      const orderForm = this.#checkout?.orderForm;
      if (
        !orderForm ||
        view.totalPence !== input.expectedTotalPence ||
        view.summary !== saved.view.summary
      )
        throw new AmazonWebError("checkout_changed_review_again");
      orderForm.data.set("placeYourOrder1", "1");
      this.#checkout = undefined; // Consume before POST. A timeout never causes a second attempt.
      const result = await this.#submit(fresh, orderForm, true);
      return { outcome: "submitted", summary: summary(result.$) };
    });
  }
}

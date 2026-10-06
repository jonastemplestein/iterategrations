import { objectOf, zincRequest, ZincError } from "./transport.js";
import type { Fetch, ZincObject } from "./transport.js";

export { ZincError } from "./transport.js";
export type { Fetch, Json, ZincObject } from "./transport.js";

export type ShippingAddress = {
  first_name: string;
  last_name: string;
  address_line1: string;
  address_line2?: string;
  city: string;
  state?: string;
  postal_code: string;
  phone_number: string;
  country: "GB";
};

export type Product = {
  url: string;
  quantity?: number;
  variant?: { label: string; value: string }[];
};

export type PlaceOrder = {
  products: Product[];
  shipping_address: ShippingAddress;
  /** Zinc calls this cents. The UK input currency needs vendor confirmation. */
  max_price: number;
  /** Persist before sending; one key per logical purchase, at most 36 characters. */
  idempotency_key: string;
};

export type AmazonOptions = {
  fetch: Fetch;
  authorization: string;
  retailerCredentialsId: string;
  /** Absent means purchases are disabled. This is a per-order cap, excluding provider fees. */
  purchasePolicy?: { maxPrice: number };
};

/** Only direct Amazon UK product URLs; reject lookalike hosts, credentials and custom ports. */
function productUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("amazon: use a direct https://www.amazon.co.uk/dp/<ASIN> URL");
  }
  const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname)?.[1];
  if (
    url.protocol !== "https:" ||
    !["amazon.co.uk", "www.amazon.co.uk"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !asin
  )
    throw new Error("amazon: only direct Amazon UK product URLs are accepted");
  return `https://www.amazon.co.uk/dp/${asin.toUpperCase()}`;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`amazon: ${label} must be a positive safe integer`);
}

function orderId(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("amazon: order ID must be a Zinc order UUID");
  return value;
}

export class AmazonApi {
  readonly #options: AmazonOptions;

  constructor(options: AmazonOptions) {
    if (!/^zn_acct_[a-zA-Z0-9]+$/.test(options.retailerCredentialsId))
      throw new Error("amazon: configure a Zinc managed-account short ID (zn_acct_...)");
    if (options.purchasePolicy) positiveInteger(options.purchasePolicy.maxPrice, "policy maxPrice");
    this.#options = {
      ...options,
      purchasePolicy: options.purchasePolicy ? { ...options.purchasePolicy } : undefined,
    };
  }

  #request(path: string, body?: ZincObject): Promise<ZincObject> {
    return zincRequest(this.#options.fetch, this.#options.authorization, path, body);
  }

  __describe(): ZincObject {
    return {
      provider: "Zinc v2",
      retailer: "amazon-uk",
      country: "GB",
      purchasesEnabled: !!this.#options.purchasePolicy,
      maxPrice: this.#options.purchasePolicy?.maxPrice ?? null,
      instructions:
        "Experimental UK support, not verified live checkout. Search coverage is unconfirmed; " +
        "use ordinary web search for Amazon UK URLs if results are empty. max_price is Zinc's " +
        "integer cap; do not assume GBP pence. Persist idempotency_key before placeOrder and " +
        "retain it on any uncertain outcome or already_exists response. Save the returned order " +
        "id and poll getOrder every 30–60 seconds. pending is not an Amazon order. A person must " +
        "handle Amazon authentication challenges; this adapter does not submit OTPs or solve them.",
      functions: ["searchProducts", "checkRetailer", "placeOrder", "getOrder", "cancelOrder"],
    };
  }

  /** Beta search; preserve provider fields but return only direct Amazon UK product URLs. */
  async searchProducts(query: string, options: { limit?: number } = {}): Promise<ZincObject> {
    if (typeof query !== "string" || !query.trim())
      throw new Error("amazon: search query is empty");
    const limit = options.limit ?? 20;
    positiveInteger(limit, "search limit");
    if (limit > 50) throw new Error("amazon: search limit must be at most 50");
    // Cross-retailer search has no documented amazon-uk slug. Filter the returned URLs locally.
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const response = await this.#request(`/search?${params.toString()}`);
    const results = Array.isArray(response.results) ? response.results : [];
    return {
      ...response,
      results: results.filter((result) => {
        try {
          const url = objectOf(result).url;
          if (typeof url !== "string") return false;
          productUrl(url);
          return true;
        } catch {
          return false;
        }
      }),
      ukCoverageVerified: false,
    };
  }

  checkRetailer(url: string): Promise<ZincObject> {
    const params = new URLSearchParams({ url: productUrl(url), country: "GB" });
    return this.#request(`/retailers/check?${params.toString()}`);
  }

  /** Submits one asynchronous job, not a completed purchase. Never retries. */
  async placeOrder(input: PlaceOrder): Promise<ZincObject> {
    const policy = this.#options.purchasePolicy;
    if (!policy)
      throw new Error("amazon: purchases are disabled; the owner must configure a policy");
    positiveInteger(input.max_price, "max_price");
    if (input.max_price > policy.maxPrice)
      throw new Error("amazon: max_price exceeds the owner cap");
    if (
      typeof input.idempotency_key !== "string" ||
      !/^[a-zA-Z0-9_-]{1,36}$/.test(input.idempotency_key)
    )
      throw new Error("amazon: supply a saved idempotency_key (1–36 letters, digits, _ or -)");
    if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 10)
      throw new Error("amazon: an order needs 1–10 product entries");
    const products: (ZincObject & { url: string })[] = input.products.map((product) => {
      const quantity = product.quantity ?? 1;
      positiveInteger(quantity, "quantity");
      const variant = product.variant?.map(({ label, value }) => {
        if (typeof label !== "string" || !label || typeof value !== "string" || !value)
          throw new Error("amazon: variant labels and values must be nonempty strings");
        return { label, value };
      });
      return {
        url: productUrl(product.url),
        quantity,
        ...(variant ? { variant } : {}),
        condition_in: ["New"],
      };
    });
    const address = input.shipping_address;
    if (address?.country !== "GB") throw new Error("amazon: shipping country must be GB");
    const shipping: ZincObject = { country: "GB" };
    for (const field of [
      "first_name",
      "last_name",
      "address_line1",
      "city",
      "postal_code",
      "phone_number",
    ] as const) {
      if (typeof address[field] !== "string" || !address[field].trim())
        throw new Error(`amazon: shipping_address.${field} is required`);
      shipping[field] = address[field];
    }
    for (const field of ["address_line2", "state"] as const) {
      if (address[field] !== undefined) {
        if (typeof address[field] !== "string") throw new Error(`amazon: invalid address ${field}`);
        shipping[field] = address[field];
      }
    }
    if (!/^\+[1-9][0-9]{7,14}$/.test(address.phone_number))
      throw new Error(
        "amazon: phone_number needs +country-code format with no spaces or national leading zero",
      );
    // Snapshot and whitelist before the first await. Caller fields cannot override the account,
    // payment, fulfillment policy, conditions or destination while preflight is running.
    const body: ZincObject = {
      products,
      shipping_address: shipping,
      max_price: input.max_price,
      idempotency_key: input.idempotency_key,
      retailer_credentials_id: this.#options.retailerCredentialsId,
      // An omitted fulfillment block is strict; "strict" is not an accepted enum value.
    };
    for (const product of products) {
      const checked = await this.checkRetailer(product.url);
      const retailer = objectOf(checked.retailer);
      if (
        checked.orderable !== true ||
        retailer.retailer !== "amazon-uk" ||
        retailer.country !== "GB"
      )
        throw new Error("amazon: Zinc preflight did not confirm an orderable Amazon UK storefront");
    }
    try {
      const order = await this.#request("/orders", body);
      if (
        order.retailer_credentials_id !== this.#options.retailerCredentialsId ||
        typeof order.id !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(order.id)
      )
        throw new ZincError(201, "invalid_order_response", true);
      return { outcome: "submitted", order };
    } catch (error) {
      if (error instanceof ZincError && error.code === "already_exists")
        return { outcome: "already_exists", idempotency_key: body.idempotency_key };
      throw error;
    }
  }

  #assertAccount(order: ZincObject): void {
    if (order.retailer_credentials_id !== this.#options.retailerCredentialsId)
      throw new Error("amazon: Zinc order does not identify the configured account; check Zinc");
  }

  async getOrder(id: string): Promise<ZincObject> {
    const order = await this.#request(`/orders/${orderId(id)}`);
    this.#assertAccount(order);
    return order;
  }

  async cancelOrder(id: string): Promise<ZincObject> {
    const order = await this.getOrder(id);
    if (order.status !== "pending")
      throw new Error("amazon: only a pending Zinc job can be cancelled");
    return this.#request(`/orders/${orderId(id)}/cancel`, {});
  }
}

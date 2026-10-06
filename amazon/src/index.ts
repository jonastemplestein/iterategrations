import { RpcTarget } from "cloudflare:workers";
import { AmazonApi } from "./client.js";
import type { AmazonOptions, PlaceOrder, ZincObject } from "./client.js";

export * from "./client.js";

/** Run in a config worker; only iterate's egress sees the Zinc API key. */
export class Amazon extends RpcTarget {
  readonly #api: AmazonApi;

  constructor(options: Omit<AmazonOptions, "authorization"> & { secret?: string }) {
    super();
    this.#api = new AmazonApi({
      ...options,
      authorization: `Bearer getSecret(${JSON.stringify(options.secret ?? "/secrets/zinc")})`,
    });
  }

  __describe(): ZincObject {
    return this.#api.__describe();
  }
  searchProducts(query: string, options?: { limit?: number }): Promise<ZincObject> {
    return this.#api.searchProducts(query, options);
  }
  checkRetailer(url: string): Promise<ZincObject> {
    return this.#api.checkRetailer(url);
  }
  placeOrder(input: PlaceOrder): Promise<ZincObject> {
    return this.#api.placeOrder(input);
  }
  getOrder(id: string): Promise<ZincObject> {
    return this.#api.getOrder(id);
  }
  cancelOrder(id: string): Promise<ZincObject> {
    return this.#api.cancelOrder(id);
  }
}

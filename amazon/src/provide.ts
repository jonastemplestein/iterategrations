import { AmazonWebApi } from "./web.js";
import { createSessionFetch } from "./node-session.js";

export const description =
  "Amazon UK shopping by direct HTTP after Chrome login: searchProducts, getProduct, getBasket, addToBasket, setQuantity, selectBasketItem, removeFromBasket, startCheckout, getCheckout, continueCheckout, placeOrder. Call __describe() first. A person handles login challenges. Purchases need an owner-configured GBP cap and an exact reviewed total. Experimental website protocol.";
type Methods = Pick<
  AmazonWebApi,
  | "__describe"
  | "searchProducts"
  | "getProduct"
  | "getBasket"
  | "addToBasket"
  | "setQuantity"
  | "selectBasketItem"
  | "removeFromBasket"
  | "startCheckout"
  | "getCheckout"
  | "continueCheckout"
  | "placeOrder"
>;
let api: AmazonWebApi | undefined;

/** `iterate provide amazon/dist/provide.js --name amazon --project <slug>`. */
export default function provide(): Methods {
  const path = process.env.AMAZON_SESSION_FILE;
  if (!path) throw new Error("amazon: set AMAZON_SESSION_FILE to a private Chrome session export");
  api ??= new AmazonWebApi({
    fetch: createSessionFetch(path),
    maxOrderPence: process.env.AMAZON_MAX_ORDER_PENCE
      ? Number(process.env.AMAZON_MAX_ORDER_PENCE)
      : undefined,
  });
  const target = api;
  return {
    __describe: () => target.__describe(),
    searchProducts: (...args) => target.searchProducts(...args),
    getProduct: (...args) => target.getProduct(...args),
    getBasket: () => target.getBasket(),
    addToBasket: (...args) => target.addToBasket(...args),
    setQuantity: (...args) => target.setQuantity(...args),
    selectBasketItem: (...args) => target.selectBasketItem(...args),
    removeFromBasket: (...args) => target.removeFromBasket(...args),
    startCheckout: () => target.startCheckout(),
    getCheckout: (...args) => target.getCheckout(...args),
    continueCheckout: (...args) => target.continueCheckout(...args),
    placeOrder: (...args) => target.placeOrder(...args),
  };
}

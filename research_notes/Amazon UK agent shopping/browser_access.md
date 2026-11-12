# Amazon UK agent shopping: browser-backed and direct access

## Official routes and their fit

### Takeaway

Amazon documents a complete direct purchase API for Amazon Business in the UK. It is the documented official route for a real UK order. It does not accept an ordinary consumer Amazon email and password as API credentials. It needs Amazon Business onboarding, approved API roles, and OAuth tokens.

### Cited Findings

- Amazon Business Ordering API can place an order and retrieve order details. The `placeOrder` request includes line items, shipping/payment attributes, and price expectations. The API is available in the EU region for the UK, Germany, France, Italy, Spain, and India. [Ordering API overview](https://docs.business.amazon.com/docs/ordering-api)
- Amazon Business Product Search API can search products and offers in the UK. Cart API can add and remove offer IDs and estimate shipping and taxes. Cart API states that an order is placed through Ordering API after cart details are retrieved. [Product Search API overview](https://docs.business.amazon.com/docs/product-search-api-overview) [Cart API overview](https://docs.business.amazon.com/docs/cart-api-overview)
- Amazon Business requires developer registration, access and refresh tokens, and the relevant Amazon Business roles. Ordering API also requires customer setup: an Amazon Business account, a buying group, a payment method, purchasing-system configuration, and activation. Orders made through an active group ship and charge. [Ordering API overview](https://docs.business.amazon.com/docs/ordering-api) [Amazon Business API roles](https://docs.business.amazon.com/docs/amazon-business-roles)
- Amazon provides a static sandbox for Cart and Product Search API calls in Europe. The documented sandbox does not list Ordering API. It is useful for building discovery and cart code before production approval, but it cannot prove a production order flow. [Amazon Business API sandbox](https://docs.business.amazon.com/docs/amazon-business-api-sandbox)
- Selling Partner API is for sellers and vendors to automate selling operations. It requires a Seller Central or vendor relationship and is not a consumer buying API. [SP-API onboarding overview](https://developer-docs.amazon.com/sp-api/docs/onboarding-overview)
- Product Advertising API is a catalogue/affiliate API, not a purchase API. Its UK documentation says that PA-API was to be deprecated on 15 May 2026 and directs developers to Creators API. It requires an Associates partner tag. [PA-API SearchItems](https://webservices.amazon.co.uk/paapi5/documentation/search-items.html)

### Inferences

- For the research experiment, convert the Amazon account to, or create, an Amazon Business account only if Amazon approves the intended integration. Then build against Product Search, Cart, and Ordering APIs. This is the route that gives agents API-native search, offer selection, cost estimation, order placement, and order status.
- Do not design an API route around a consumer email/password. The documented API authentication model is application OAuth and authorization, not consumer-password exchange.
- A suitable initial acceptance test is the Amazon Business sandbox for search/cart, followed by a tightly bounded live order only after API approval and account setup. No source reviewed proves that an ordinary consumer account can perform this flow through an official API.

### Gaps

- The reviewed public documentation does not state whether a new Amazon Business developer application for this research use case will be approved. Amazon must decide that during onboarding.
- The sources do not establish whether the current consumer account can be migrated without business-account or payment changes. That needs a non-production account check with Amazon Business.

## Consumer browser and HTTP routes

### Takeaway

A browser can automate the ordinary consumer web flow after an interactive sign-in, but Amazon can demand MFA, a passkey, device verification, or a visual challenge. The later live experiment verified direct HTTP search, basket changes, address selection and checkout review on an Amazon Business account. A subsequent approved purchase ran through a self-hosted Iterate MCP server; Amazon order history confirmed it. See [the current report](../../reports/Amazon%20UK%20agent%20shopping.md) and [HTTP trace](http_trace.json). The website protocol has no documented public support commitment.

### Cited Findings

- Amazon UK grants a limited licence for personal, non-commercial use. Its Conditions of Use exclude collection and use of listings, descriptions, or prices, and the use of data-mining, robots, or similar data-gathering and extraction tools. It also prohibits extracting or reusing substantial parts of Amazon Services without express written consent. [Amazon UK Conditions of Use & Sale](https://digprjsurvey.amazon.co.uk/csad/help/node/GLSBYFE9MGKKQXXM)
- Amazon supports two-step verification using SMS, voice call, or an authenticator app. A password alone can therefore be insufficient to sign in. [Amazon account security guidance](https://www.aboutamazon.com/news/retail/how-to-secure-your-amazon-account)
- Amazon UK supports passkeys. The passkey lives with its provider account, and Amazon says a separate marketplace can need a new passkey or ordinary password sign-in. [Amazon UK passkey help](https://digprjsurvey.amazon.co.uk/csad/help/node/TPphmhSWBgcI9Ak87p)
- Playwright can save and restore browser storage state, including cookies, local storage, IndexedDB, and virtual WebAuthn credentials. Its documentation warns that the snapshot contains sensitive state and should be kept local. [Playwright authentication](https://playwright.dev/docs/auth) [BrowserContext storage state](https://playwright.dev/docs/api/class-browsercontext)
- The open-source [`amazon-orders`](https://github.com/alexdlaird/amazon-orders) library is explicitly unofficial. Its README says it parses Amazon's consumer website, that Amazon provides no official API, and that versions can break. It officially supports only English `.com`; other domains may work by chance. It provides order history, line items, and transactions, not product search, cart mutation, or checkout. [amazon-orders README](https://github.com/alexdlaird/amazon-orders/blob/main/README.md)
- `amazon-orders` documents an HTTP-to-Playwright cookie bridge for JavaScript login challenges. It also documents visible, manual handling for AWS WAF and visual challenges. This is evidence that an HTTP client can need a real browser merely to authenticate; it is not evidence that checkout works over HTTP or on amazon.co.uk. [amazon-orders browser documentation](https://amazon-orders.readthedocs.io/browser.html)

### Inferences

- Use the authorized real Chrome profile and a task tab. Let a human complete first sign-in, MFA, passkey, and any visual challenge. Treat the saved browser state as an account credential: encrypt it, give it account-scoped access, and rotate it after invalidation.
- Do not give model workers the Amazon password or raw cookies. A shopping service should own both. It should return narrow, typed results to the agent and perform browser actions only through its own policy checks.
- Avoid CAPTCHA/WAF-solving services. They do not make the consumer route stable or authorised, and a human-visible challenge hand-off is the evidence-backed fallback.
- The direct client must load current forms and CSRF values. The live capture established working basket and checkout-review requests. One stored-address, stored-card order was then verified through MCP and order history. Other account and checkout variants remain unverified.

### Gaps

- No primary Amazon source reviewed offers a consumer-account API for search, basket, payment selection, or order placement.
- No reviewed open-source project documents a tested, maintained consumer checkout client for amazon.co.uk. The available client does not claim this capability.
- Amazon can vary sign-in and challenge behaviour by account, device, and risk signals. No source can predict which challenge an experiment account will receive until a controlled browser test occurs.

## Recommended agent-facing facade

### Takeaway

Expose one structured shopping interface to agents, with two providers: Amazon Business API when approved, and a consumer browser adapter for the research path. Keep final purchase as an explicit, reviewable operation with an immutable quote and an idempotency key.

### Cited Findings

- Amazon Business Ordering API supports caller-defined external IDs, price and charge expectations, partial acceptance/rejection details, and order-status retrieval. These fields support idempotency, a pre-purchase quote, and safe handling of changed price or stock. [Ordering API overview](https://docs.business.amazon.com/docs/ordering-api)
- Cart API only accepts ASINs and offer IDs obtained through Amazon Business Product Search API, and it provides a total-purchase-cost estimate. [Cart API overview](https://docs.business.amazon.com/docs/cart-api-overview)
- Playwright supports isolated contexts and restoring saved authentication state. This permits account separation for a browser-backed provider. [Playwright authentication](https://playwright.dev/docs/auth)

### Inferences

- Define provider-neutral operations: `search(query, filters)`, `get_offer(asin_or_offer_id)`, `quote(items, destination)`, `prepare_checkout(quote_id)`, `place_order(confirmation_id, idempotency_key)`, and `get_order(order_id)`. Return the source, price, delivery promise, seller, and capture time in each quote.
- In the Business provider, map search to Product Search, quoting to Cart cost estimation, and final placement to Ordering API. Require an expected-total and expected-unit-price ceiling in the order request, so a price movement rejects rather than silently charges more.
- In the consumer-browser provider, a dedicated Playwright/Playwriter worker owns a persistent context. It navigates search, product, basket, and checkout pages and converts the observed UI into the same typed records. It pauses with a machine-readable `needs_human_auth` or `needs_human_challenge` state when Amazon requests MFA, a passkey, or a challenge.
- Create `prepare_checkout` before every order. It records the exact items, quantity, selected offer/seller, destination, delivery, currency, final total, browser timestamp, and screenshot or page reference. A separate `place_order` call can then enforce policy limits and avoid an accidental retry. Browser changes must expect selector and flow drift, so include a tested state machine and screenshots/HTML diagnostics for failures.
- Prefer Amazon Business API for any durable integration. Use the consumer browser adapter only as a constrained experiment, and seek Amazon's written permission before operating automated agents against consumer Amazon pages because the UK Conditions expressly restrict robots and extraction.

### Gaps

- The facade design has not been tested against an Amazon account. It needs a controlled test account and must not be described as a verified sign-in or checkout implementation.
- The exact Amazon Business approval, credential issuance, and customer configuration steps depend on Amazon's onboarding decision.

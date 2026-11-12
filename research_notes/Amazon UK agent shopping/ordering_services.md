# Amazon.co.uk ordering services

## Zinc API: current UK order route

### Takeaway

Zinc is the only researched provider with a documented API order route that its live preflight currently marks as orderable for Amazon.co.uk delivery to GB. The route is usable only with a customer Amazon account; Zinc marks it `observed`, with no completed order recorded, so it is an experiment rather than a verified production path.

### Cited Findings

- `GET https://api.zinc.com/retailers/check?url=https%3A%2F%2Fwww.amazon.co.uk%2Fdp%2FB0C2J7Z17K&country=GB` returned `orderable: true`, Amazon UK storefront slug `amazon-uk`, `ships_to: ["GB"]`, `guest_checkout: false`, and `use_your_account: true`. Its response directs callers to `POST /orders` with the product URL. [Live Zinc preflight result](https://api.zinc.com/retailers/check?url=https%3A%2F%2Fwww.amazon.co.uk%2Fdp%2FB0C2J7Z17K&country=GB)
- The same live result gives support tier `observed`, `orders_placed: false`, and no last successful order. Zinc documents `observed` as an orderable store where it has attempted orders, and says that some observed stores have no completed orders. [Live Zinc preflight result](https://api.zinc.com/retailers/check?url=https%3A%2F%2Fwww.amazon.co.uk%2Fdp%2FB0C2J7Z17K&country=GB); [support-tier documentation](https://www.zinc.com/docs/v2/api-reference/retailers/check-retailer)
- Zinc's curated `GET /retailers` catalog is not the limit of its checkout route. The provider says callers must use `GET /retailers/check` for a URL and destination, and that this applies the same gates as `POST /orders`. [Check a Retailer](https://www.zinc.com/docs/v2/api-reference/retailers/check-retailer)
- Authenticated order creation is `POST https://api.zinc.com/orders`. It requires `products`, `shipping_address`, and integer `max_price`; product URLs are resolved to a retailer from the URL. The documented order response returns an ID and initially pending status, and processing is asynchronous. [Create Order](https://www.zinc.com/docs/v2/api-reference/orders/create-order)
- Supply the managed account short ID as `retailer_credentials_id: "zn_acct_…"`; the order schema says Zinc otherwise selects credentials automatically. The required account fields are `email`; `password`, storefront `retailer`, and `totp_secret` are optional. Zinc says passwords and TOTP secrets are encrypted at rest and never returned. [Create Managed Account](https://www.zinc.com/docs/v2/api-reference/managed-accounts/create-managed-account); [Create Order](https://www.zinc.com/docs/v2/api-reference/orders/create-order)
- The managed-account `retailer` field has no documented enum. Zinc defines it as a storefront slug, and the current Amazon.co.uk preflight returns the exact storefront slug `amazon-uk`; use that value when registering UK credentials, then verify the returned `retailer` and `retailer_id`. [Live Zinc preflight result](https://api.zinc.com/retailers/check?url=https%3A%2F%2Fwww.amazon.co.uk%2Fdp%2FB0C2J7Z17K&country=GB); [managed-account schema](https://www.zinc.com/docs/v2/api-reference/managed-accounts/create-managed-account)
- Account registration requires the Amazon email and password in a JSON request body. There is no documented header-only or URL-only credential-registration alternative. This conflicts with an integration that substitutes secrets only in request URLs and headers. [Retailer Credentials](https://www.zinc.com/docs/v2/api-reference/configuration/managed-accounts)
- Zinc permits a TOTP secret and email/SMS forwarding to automate retailer verification. Those options would bypass a person for challenges, so they do not fit a person-in-the-loop design for SMS, CAPTCHA, passkey, or other Amazon challenge responses. [Retailer Credentials](https://www.zinc.com/docs/v2/api-reference/configuration/managed-accounts); [Amazon Email Verification (legacy v1)](https://www.zinc.com/docs/v1/api-reference/appendix/amazon-email-verification)
- One managed account processes one order at a time; concurrent orders on it queue sequentially. [Retailer Credentials](https://www.zinc.com/docs/v2/api-reference/configuration/managed-accounts)
- Persist one `idempotency_key` per logical purchase. Zinc says to reuse it for network and 5xx retries; `already_exists` means the original order exists, so it is a successful retry outcome. Do not retry validation, authentication, or payment failures. [Idempotency](https://www.zinc.com/docs/v2/api-reference/introduction/idempotency)
- Poll `GET /orders/{id}` for status, job result, merchant order IDs, and price components; Zinc recommends polling every 30–60 seconds while processing. `POST /orders/{id}/cancel` works only while an order is pending in Zinc's queue. [Get Order](https://www.zinc.com/docs/v2/api-reference/orders/get-order); [Cancel Order](https://www.zinc.com/docs/v2/api-reference/orders/cancel-order)
- `max_price` is documented only as an integer in “cents”. Zinc does not document the request currency for an Amazon.co.uk order. The final response distinguishes retailer `currency` from `payment_currency`, and documents conversion where they differ. Do not call the request value GBP pence until Zinc confirms it or a non-live test establishes it. [Create Order](https://www.zinc.com/docs/v2/api-reference/orders/create-order); [Get Order](https://www.zinc.com/docs/v2/api-reference/orders/get-order)
- Zinc's generated OpenAPI text also says its listed countries are US, DE, and IT, which conflicts with the live Amazon UK GB preflight. The specific preflight is the provider's documented authoritative check for a URL and destination; retain this conflict as a launch risk. [Check a Retailer](https://www.zinc.com/docs/v2/api-reference/retailers/check-retailer); [Create Order](https://www.zinc.com/docs/v2/api-reference/orders/create-order)
- A `zn_test_` key uses an isolated sandbox database, creates no retail order or charge, and can simulate success, out-of-stock, price-cap, address, URL, variant, shipping, and wallet scenarios through Zinc test product URLs. Sandbox skips URL, country, and address validations, so it cannot confirm a real Amazon.co.uk path or the UK `max_price` currency. [Sandbox & Testing](https://www.zinc.com/docs/v2/api-reference/introduction/sandbox)
- For discovery only, `GET /search?q=<query>` is a beta cross-retailer search. Optional query parameters are repeatable `retailer`, `sort` (`relevance`, `price_asc`, `price_desc`, or `rating`), and `limit` (1–50); each result contains an orderable `url`, retailer, title, price, and availability fields. It costs $0.01 per successful production call and does not document Amazon UK-specific coverage. [Cross-Retailer Search](https://www.zinc.com/docs/v2/api-reference/search/cross-retailer)
- `GET /products/search?query=<query>&retailer=<retailer>` is a separate per-retailer discovery endpoint. Its documented retailer identifiers list `amazon`, but not `amazon-uk`, so it must not be used as evidence of Amazon.co.uk search support. It is also billed $0.01 per successful production call. [Search Products](https://www.zinc.com/docs/v2/api-reference/products/search)

### Inferences

- Design a Zinc provider around a preflight for every Amazon.co.uk URL and GB delivery address, a private credential-registration step, an explicit `retailer_credentials_id`, a hard price ceiling, a persisted idempotency key, and status polling.
- The credentials endpoint cannot be safely used until Iterate can inject protected values into JSON bodies, or credentials are registered by a separate private setup service. The normal order request then needs no Amazon password.
- Treat all interactive verification as a paused state that requests a human response. Do not configure automated TOTP, email forwarding, SMS forwarding, CAPTCHA solving, or passkey handling as the default path.

### Gaps

- Zinc has not published an Amazon.co.uk success rate, a completed-order date, a current UK fee schedule, or the `max_price` request currency. Confirm these with Zinc before a live experiment.
- The public documents do not explicitly say whether an `amazon-uk` managed account is selected for an `amazon.co.uk` URL. The live preflight and free-form retailer field support that mapping, but only a sandbox or vendor confirmation can validate it without risking a purchase.

## Rye Universal Checkout API

### Takeaway

Rye documents real Amazon order APIs, but its current published limitation is US-only ordering and it does not support login or non-guest checkout. It therefore cannot meet an Amazon.co.uk user-account requirement.

### Cited Findings

- Rye documents a Universal Checkout API that takes a product URL and buyer identity, and says it performs pricing, tax, shipping, payment, and merchant order placement. [Rye API introduction](https://rye.com/docs/api-v2/introduction)
- Rye documents a one-call, asynchronous purchase endpoint: `POST /api/v1/checkout-intents/purchase`; callers poll `GET /api/v1/checkout-intents/{id}` to a terminal `completed` or `failed` state. [Single Step Checkout](https://rye.com/docs/api-v2/example-flows/single-step-checkout); [Checkout Intent Lifecycle](https://rye.com/docs/api-v2/checkout-intent-lifecycle)
- Rye has a published Amazon cart and `submitCart` example, but it requires Rye console authorization, shopper IP, buyer details, and a payment flow. It does not ask for an Amazon account email or password. [Placing Amazon Orders via API](https://rye.com/docs/order-from-amazon-typescript)
- Rye's current API limitations state that login and non-guest checkout flows are unsupported, and that ordering is US-only. It says additional regions may be available on request for enterprise use. [API Limitations](https://rye.com/docs/api-v2/developer-notes)
- Rye supports Stripe and Basis Theory tokens, or a pre-funded Rye drawdown balance. With drawdown the developer collects funds and Rye draws from the developer balance. [Payment Providers](https://rye.com/docs/api-v2/payment-providers)
- Rye's documented staging environment does not place real orders or process real financial transactions; production has separate credentials and can charge real methods. [Environments](https://rye.com/docs/api-v2/environments)
- Rye documents retry guidance for 429, 500, and 503 responses, and says a 409 can be retried only if safe. Its docs do not provide an idempotency-key contract equivalent to Zinc's. [Handling API Errors](https://rye.com/docs/api-v2/errors)

### Inferences

- Rye is an order-capable alternative for a US, guest-checkout research path. It is not a candidate for the requested UK Amazon account-login path unless Rye provides written enterprise confirmation of both UK delivery and Amazon.co.uk support.

### Gaps

- Rye does not publish UK coverage, Amazon.co.uk support, UK pricing, or a customer-account login mechanism in the cited documentation.

## APIs that do not place consumer Amazon orders

### Takeaway

Amazon's official Selling Partner API is for sellers and vendors to manage selling operations. It is useful for an Amazon merchant's catalog and fulfilment work, but it is not a consumer Amazon.co.uk purchase API and cannot replace Zinc for this experiment.

### Cited Findings

- Amazon describes SP-API as an API for a selling partner, defined as a seller or vendor, to automate selling operations such as order processing, shipment tracking, and payment management. [SP-API onboarding](https://developer-docs.amazon.com/sp-api/docs/onboarding-overview)
- Amazon's Orders API is described as retrieving order information for a selling partner; its listed operations include searching and retrieving those orders and confirming shipment status. [Amazon Orders API](https://developer-docs.amazon.com/sp-api/docs/orders-api)
- Amazon lists the UK under its Europe SP-API endpoint. This gives seller-side UK coverage, but does not create a buyer checkout operation. [SP-API endpoints](https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints)

### Inferences

- Keep product lookup or scraping/search APIs separate from an order provider. They can support research and price checks, but do not meet the requirement to log into a consumer Amazon account and submit a retail purchase.

### Gaps

- No official Amazon consumer-order API was found in Amazon's primary developer documentation. This research did not test third-party scraping providers because they are not documented consumer order APIs.

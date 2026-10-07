import { APP_SECRET, INSTALLATION_ID, INSTALLATIONS, streamOf, type GithubItx } from "./app.js";

/** GitHub's webhook for the App. GitHub POSTs each delivery as JSON with `X-Hub-Signature-256:
 *  sha256=<hex>`, the HMAC-SHA256 of the raw body under the App's webhook secret
 *  (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), checked
 *  against `/secrets/own-github-app`'s `webhookSecret` with `itx.secrets.verifyHmac`: a delivery
 *  that is not signed so is 401 and stores nothing. `installation.id` in the body names the
 *  installation; one this page did not connect is acknowledged and dropped. Each delivery lands
 *  once on `/integrations/own-github/<installation id>` as `github/delivery-received`, keyed by
 *  `X-GitHub-Delivery`, so a redelivery adds nothing. */
export async function receiveDelivery(request: Request, itx: GithubItx): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const raw = await request.text();
  const signature = /^sha256=([0-9a-fA-F]{64})$/.exec(
    request.headers.get("x-hub-signature-256") ?? "",
  )?.[1];
  const genuine =
    signature !== undefined &&
    (await itx.secrets.verifyHmac(APP_SECRET, {
      payload: raw,
      signature,
      field: "webhookSecret",
    }));
  if (!genuine) return new Response("bad signature\n", { status: 401 });

  // authenticated: what cannot be used is acknowledged, so GitHub does not mark it failed
  let body: { installation?: { id?: unknown } } | null;
  try {
    body = JSON.parse(raw) as { installation?: { id?: unknown } } | null;
  } catch {
    return Response.json({ ok: true, ignored: "not JSON" });
  }
  const named = body?.installation?.id;
  const id = typeof named === "number" || typeof named === "string" ? String(named) : "";
  if (!INSTALLATION_ID.test(id) || !(await itx.kv.get(`${INSTALLATIONS}${id}`)))
    return Response.json({ ok: true, ignored: "unknown-installation" });
  const delivery = request.headers.get("x-github-delivery") ?? "";
  if (!/^[A-Za-z0-9-]{1,100}$/.test(delivery))
    return Response.json({ ok: true, ignored: "no delivery id" });

  await itx
    .cd(streamOf(id))
    .append({
      type: "github/delivery-received",
      idempotencyKey: `github:${id}:${delivery}`,
      payload: {
        installationId: id,
        delivery: { id: delivery, name: request.headers.get("x-github-event") ?? "" },
        body,
      },
    })
    .catch((error: unknown) => {
      // a redelivery of the same delivery: it landed already
      if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
    });
  return Response.json({ ok: true });
}

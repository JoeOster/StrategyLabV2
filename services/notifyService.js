// Best-effort outbound webhook for fired price alerts. Deliberately generic:
// this app has no idea what's on the other end (an email relay, a Pushover
// bridge, ai_orchestrator's own automations, a plain curl-to-a-script) and
// isn't trying to. It just POSTs a JSON payload if a URL is configured, and
// otherwise does nothing. See Settings > General "Alert webhook URL".
//
// A failed delivery must never break the caller -- checkAlerts()'s job is
// recording the alert in the DB, which already happened by the time this
// runs. A dead webhook endpoint shouldn't make the app think alert-checking
// itself failed.
import { getGeneralSettings } from "./settingsService.js";

/**
 * @param {Array<{watchedItemId: number, symbol: string, price: number}>} firedAlerts
 */
export async function deliverAlertWebhook(firedAlerts) {
  if (!firedAlerts || firedAlerts.length === 0) return { sent: false, reason: "no-alerts" };

  const { alert_webhook_url: url, alert_webhook_auth_header: authHeader } = getGeneralSettings();
  if (!url) return { sent: false, reason: "not-configured" };

  const payload = {
    event: "alerts_triggered",
    triggeredAt: new Date().toISOString(),
    alerts: firedAlerts.map((a) => ({
      watchedItemId: a.watchedItemId,
      symbol: a.symbol,
      price: a.price,
    })),
  };

  const headers = { "Content-Type": "application/json" };
  if (authHeader) headers.Authorization = authHeader;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[notifyService] Webhook responded ${res.status} ${res.statusText}`);
      return { sent: false, reason: `http-${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    // Network errors, DNS failures, unreachable hosts -- all swallowed the
    // same way. Whoever configured the URL can check their own endpoint's
    // logs; this app just shouldn't crash or block over it.
    console.error("[notifyService] Webhook delivery failed:", err.message);
    return { sent: false, reason: "network-error" };
  }
}

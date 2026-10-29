import webpush from "web-push";
import { pool } from "../db/pool.js";

// Sending one phone notification. Keys come from the environment (see .env.example):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   make once with: npx web-push generate-vapid-keys
//   VAPID_SUBJECT                         mailto: address the phone makers can reach
// Without them, push is simply off: the parent screen doesn't offer alerts.

const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || null;
const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || null;
const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:office@example.com";

let ready = false;
if (publicKey && privateKey) {
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    ready = true;
  } catch (error) {
    console.error("Push keys are set but not valid; phone alerts are off.", error);
  }
}

export const pushPublicKey = () => (ready ? publicKey : null);

export type PushMessage = { title: string; body: string; tag: string; url?: string };

/** Send to every phone this person turned alerts on for. Dead subscriptions are removed. Returns how many got it. */
export async function pushToMember(memberId: string, message: PushMessage): Promise<number> {
  if (!ready) return 0;
  const subs = await pool.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = $1", [memberId]);
  let delivered = 0;
  await Promise.all(subs.rows.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: message.title, body: message.body, tag: message.tag, url: message.url ?? "/" }),
        { TTL: 15 * 60, urgency: "high" });
      delivered++;
      await pool.query("UPDATE push_subscriptions SET last_sent_at = now() WHERE id = $1", [sub.id]);
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
      // 404/410: the phone turned alerts off or the browser was reset. Forget it.
      if (status === 404 || status === 410) await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [sub.id]);
      else console.error("Push failed", status ?? error);
    }
  }));
  return delivered;
}

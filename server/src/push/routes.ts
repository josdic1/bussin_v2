import { Router } from "express";
import { pushSubscribeInputSchema, pushUnsubscribeInputSchema } from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { pushPublicKey, pushToMember } from "./send.js";

// A parent turns bus alerts on or off for the phone they're holding.

export const pushRoutes = Router();

/** The public key the phone needs to subscribe. null: alerts aren't set up on this server. */
pushRoutes.get("/key", requireRole("family"), (_request, response) => {
  response.json({ publicKey: pushPublicKey() });
});

pushRoutes.post("/subscribe", requireSameOrigin, requireRole("family"), async (request, response) => {
  const input = pushSubscribeInputSchema.safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: "This phone sent an alert setup Bussin can't use." }); return; }
  if (!pushPublicKey()) { response.status(409).json({ error: "Bus alerts aren't set up yet. Ask the camp office." }); return; }
  const member = currentMember(response);
  // The same phone signing in as someone else moves to that person.
  await pool.query(
    `INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET member_id = EXCLUDED.member_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent`,
    [member.id, input.data.endpoint, input.data.keys.p256dh, input.data.keys.auth,
      request.get("user-agent")?.slice(0, 300) ?? null]);
  response.status(204).end();
});

pushRoutes.post("/unsubscribe", requireSameOrigin, requireRole("family"), async (request, response) => {
  const input = pushUnsubscribeInputSchema.safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: "Choose a phone." }); return; }
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND member_id = $2", [input.data.endpoint, currentMember(response).id]);
  response.status(204).end();
});

/** "Send me a test": proves the whole path works before the first real bus. */
pushRoutes.post("/test", requireSameOrigin, requireRole("family"), async (_request, response) => {
  const delivered = await pushToMember(currentMember(response).id, {
    title: "Bus alerts are on", body: "You'll hear when the bus leaves, when it's 10 minutes away, and when it's at your stop.", tag: "test"
  });
  if (!delivered) { response.status(409).json({ error: "That didn't reach this phone. Turn alerts off and on again." }); return; }
  response.status(204).end();
});

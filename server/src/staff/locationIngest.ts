import type { Response } from "express";
import { staffLocationSampleResponseSchema, type staffLocationSampleInputSchema } from "@bussin/shared";
import type { z } from "zod";
import { pool } from "../db/pool.js";
import { applyJourneyFromGps } from "./journey.js";
import { locationDatabaseRejectionReason, locationSampleRejectionReason } from "./locationPolicy.js";

type Sample = z.infer<typeof staffLocationSampleInputSchema>;

/**
 * Stores one GPS fix and runs stop auto-detect. Used by staff phones and by bus
 * trackers once each has confirmed the fix belongs to its running trip and is not
 * a duplicate. `sender` says who sent it; `journeyActorId` is the member the
 * automatic arrive/depart events are recorded as (null skips auto-detect).
 */
export async function ingestLocation(
  response: Response,
  sample: Sample,
  sender: { memberId: string } | { deviceId: string },
  journeyActorId: string | null
): Promise<void> {
  const rejectionReason = locationSampleRejectionReason(sample);
  if (rejectionReason) {
    response.status(202).json(staffLocationSampleResponseSchema.parse({ accepted: false, reason: rejectionReason }));
    return;
  }

  try {
    await pool.query(
      `INSERT INTO trip_location_samples (
         trip_id, member_id, device_id, client_sample_id, observed_at,
         latitude, longitude, accuracy_m, speed_mps, heading_degrees
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        sample.tripId,
        "memberId" in sender ? sender.memberId : null,
        "deviceId" in sender ? sender.deviceId : null,
        sample.clientSampleId,
        sample.observedAt,
        sample.latitude,
        sample.longitude,
        sample.accuracyM,
        sample.speedMps,
        sample.headingDegrees
      ]
    );
  } catch (error) {
    const qualityRejection = locationDatabaseRejectionReason(error);
    if (qualityRejection) {
      response.status(202).json(staffLocationSampleResponseSchema.parse({ accepted: false, reason: qualityRejection }));
      return;
    }
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "23505") {
        response.status(200).json(staffLocationSampleResponseSchema.parse({ accepted: false, reason: "duplicate" }));
        return;
      }
      if (error.code === "P0001") {
        response.status(409).json({ error: "This location sample no longer belongs to an active assigned trip." });
        return;
      }
    }
    throw error;
  }

  // Journey automation is deliberately isolated from canonical GPS storage.
  // If automation fails, the accepted GPS sample remains valid and manual
  // Arrive/Depart controls continue to work exactly as before.
  let journeyResult: Awaited<ReturnType<typeof applyJourneyFromGps>> = { transition: null, progress: null };
  let journeyFailed = false;
  if (journeyActorId) {
    const journeyClient = await pool.connect();
    try {
      // Test hook only: lets the browser test prove the phone shows a failure.
      if (process.env.BUSSIN_TEST_FAIL_JOURNEY === "1") throw new Error("Test: journey automation disabled");
      await journeyClient.query("BEGIN");
      await journeyClient.query("SET LOCAL lock_timeout = '3s'");
      journeyResult = await applyJourneyFromGps(journeyClient, { tripId: sample.tripId, actorId: journeyActorId });
      await journeyClient.query("COMMIT");
    } catch (error) {
      await journeyClient.query("ROLLBACK").catch(() => undefined);
      journeyFailed = true;
      console.error("Journey GPS automation failed; manual trip controls remain available.", error);
    } finally {
      journeyClient.release();
    }
  }

  // A header, not a body field: phones running an older copy ignore it safely.
  if (journeyFailed) response.setHeader("X-Bussin-Journey-Error", "1");
  if (journeyResult.progress) {
    response.setHeader("X-Bussin-Journey-Progress", encodeURIComponent(JSON.stringify(journeyResult.progress)));
  }
  response.status(201).json(staffLocationSampleResponseSchema.parse({ accepted: true, journey: journeyResult.transition }));
}

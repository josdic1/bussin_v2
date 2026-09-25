import { useEffect, useState } from "react";
import {
  familyPortalResponseSchema,
  type FamilyPortalRide
} from "@bussin/shared";
import { useAuth } from "../auth/AuthProvider";

function time(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function leaveText(ride: FamilyPortalRide, now: number) {
  if (ride.stop.arrivedAt || ride.stop.departedAt) return null;
  if (!ride.eta?.leaveAt) return null;

  const seconds = Math.ceil((Date.parse(ride.eta.leaveAt) - now) / 1000);

  if (seconds <= 0) return "LEAVE NOW";

  const minutes = Math.ceil(seconds / 60);
  return `LEAVE IN ${minutes} MIN`;
}

function etaStatus(ride: FamilyPortalRide) {
  if (ride.stop.arrivedAt) {
    return `ARRIVED · ${time(ride.stop.arrivedAt)}`;
  }

  if (ride.tripStatus === "planned") {
    return `Scheduled ${time(ride.departureAt)}`;
  }

  if (!ride.eta || ride.eta.status === "calculating") {
    return "Calculating arrival…";
  }

  if (ride.eta.status === "stale") {
    return "Live arrival unavailable · location stale";
  }

  if (ride.eta.status === "off-route") {
    return "Live arrival unavailable · bus off route";
  }

  if (ride.eta.status === "unavailable" || !ride.eta.stopEtaAt) {
    return "Live arrival unavailable";
  }

  return `Expected at your stop ${time(ride.eta.stopEtaAt)}`;
}

export function FamilyPortalPage() {
  const { logout } = useAuth();
  const [rides, setRides] = useState<FamilyPortalRide[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch("/api/families/portal", {
          credentials: "same-origin",
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error("Could not load your bus information.");
        }

        const body = familyPortalResponseSchema.parse(await response.json());

        if (!controller.signal.aborted) {
          setRides(body.rides);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load your bus information."
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), 15_000);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="family-portal">
      <header className="family-portal-head">
        <div>
          <p className="eyebrow">BUSSIN / FAMILY</p>
          <h1>Your bus</h1>
        </div>
        <button
          className="auth-text-button"
          type="button"
          onClick={() => void logout()}
        >
          Sign out
        </button>
      </header>

      {error && <p className="auth-error" role="alert">{error}</p>}

      {loading ? (
        <p>Loading your bus…</p>
      ) : rides.length === 0 ? (
        <section className="dispatch-card">
          <h2>No current trip</h2>
          <p>There is no active or upcoming bus trip linked to your rider.</p>
        </section>
      ) : (
        <div className="family-rides">
          {rides.map((ride) => {
            const leave = leaveText(ride, now);

            return (
              <section className="dispatch-card family-ride-card" key={`${ride.riderId}-${ride.tripId}`}>
                <p className="eyebrow">{ride.servicePeriod} ROUTE</p>
                <h2>{ride.riderName}</h2>

                {leave && (
                  <div className="family-leave-now" role="status">
                    {leave}
                  </div>
                )}

                <p className="family-eta">
                  <strong>{etaStatus(ride)}</strong>
                </p>

                <dl className="family-trip-facts">
                  <div>
                    <dt>Bus</dt>
                    <dd>{ride.busLabel}</dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>{ride.routeName}</dd>
                  </div>
                  <div>
                    <dt>Your stop</dt>
                    <dd>{ride.stop.label}</dd>
                  </div>
                  {!ride.stop.arrivedAt && !ride.stop.departedAt && (
                    <div>
                      <dt>Leave buffer</dt>
                      <dd>{ride.eta?.leaveBufferMinutes ?? 5} min</dd>
                    </div>
                  )}
                </dl>

                {ride.stop.arrivedAt && (
                  <p>Bus reached your stop at {time(ride.stop.arrivedAt)}.</p>
                )}

                {ride.stop.departedAt && (
                  <p>Bus departed your stop at {time(ride.stop.departedAt)}.</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

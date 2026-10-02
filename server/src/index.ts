import { fileURLToPath } from "node:url";
import express from "express";
import { authRoutes } from "./auth/routes.js";
import { fleetRoutes } from "./fleet/routes.js";
import { routeRoutes } from "./routes/routes.js";
import { geocodeRoutes } from "./geocode/routes.js";
import { dispatchRoutes } from "./dispatch/routes.js";
import { familyRoutes } from "./families/routes.js";
import { memberRoutes } from "./members/routes.js";
import { staffRoutes } from "./staff/routes.js";
import { checkRoutes } from "./check/routes.js";
import { adminRoutes } from "./admin/routes.js";
import { messageRoutes } from "./messages/routes.js";
import { readTenant } from "./db/tenant.js";
import { pool } from "./db/pool.js";
import { closeListener } from "./db/listen.js";
import { frontendStatic, securityHeaders } from "./http.js";
import { closeAllStreams } from "./sse.js";

const tenant = await readTenant();

const app = express();
const isProduction = process.env.NODE_ENV === "production";

// Railway terminates TLS in front of the app; trust one proxy hop so
// request.ip and secure cookies see the real client and protocol.
app.set("trust proxy", isProduction ? 1 : false);
app.disable("x-powered-by");
app.use(securityHeaders);

app.use(express.json({ limit: "32kb" }));
app.use("/api", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});
app.use("/api/auth", authRoutes);
app.use("/api/fleet", fleetRoutes);
app.use("/api/routes", routeRoutes);
app.use("/api/geocode", geocodeRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/families", familyRoutes);
app.use("/api/members", memberRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/check", checkRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/messages", messageRoutes);

app.get("/health", (_request, response) => {
  response.json({ status: "running" });
});

if (isProduction) {
  const frontendDist = fileURLToPath(
    new URL("../../frontend/dist/", import.meta.url)
  );
  const frontendIndex = fileURLToPath(
    new URL("../../frontend/dist/index.html", import.meta.url)
  );

  app.use(frontendStatic(frontendDist));
  app.use(express.static(frontendDist, {
    index: false,
    setHeaders(response, path) {
      response.setHeader("Cache-Control", path.includes("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache");
    }
  }));

  app.use((request, response, next) => {
    if (
      request.method !== "GET" ||
      request.path.startsWith("/api/") ||
      request.path === "/health"
    ) {
      next();
      return;
    }

    response.set("Cache-Control", "no-cache");
    response.sendFile(frontendIndex);
  });
}

const port = Number(process.env.PORT ?? 3001);

const server = app.listen(port, isProduction ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Bussin ${tenant.name} server listening on port ${port}`);
});

/** Redeploys send SIGTERM: stop accepting, end live streams, drain the pool. */
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  closeAllStreams();
  const force = setTimeout(() => process.exit(0), 8_000);
  force.unref();
  server.close(() => {
    closeListener();
    void pool.end().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server kept running)", reason);
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

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
import { dataRoutes } from "./data/routes.js";
import { dataImportRoutes } from "./data/import.js";
import { tableCsvRoutes } from "./data/tableCsv.js";
import { deviceRoutes, trackerRoutes } from "./device/routes.js";
import { readTenant } from "./db/tenant.js";
import { pool } from "./db/pool.js";
import { closeListener } from "./db/listen.js";
import { frontendStatic, securityHeaders } from "./http.js";
import { closeAllStreams } from "./sse.js";
import { startAutoFinish } from "./trips/autoFinish.js";
import { readFile } from "node:fs/promises";

async function readFrontendBuild(): Promise<string | null> {
  try {
    const raw = await readFile(new URL("../../frontend/dist/version.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && "build" in parsed && typeof parsed.build === "string"
      ? parsed.build : null;
  } catch {
    return null;
  }
}

const tenant = await readTenant();

const app = express();
const isProduction = process.env.NODE_ENV === "production";

// Railway terminates TLS in front of the app; trust one proxy hop so
// request.ip and secure cookies see the real client and protocol.
app.set("trust proxy", isProduction ? 1 : false);
app.disable("x-powered-by");
app.use(securityHeaders);

// Roster import takes whole files, so it reads its own (larger) request bodies first.
app.use("/api/data/import", (_request, response, next) => { response.set("Cache-Control", "no-store"); next(); }, dataImportRoutes);
app.use("/api/data/csv", (_request, response, next) => { response.set("Cache-Control", "no-store"); next(); }, tableCsvRoutes);
app.use(express.json({ limit: "32kb" }));
app.use("/api", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});
app.use("/api/auth", authRoutes);
app.use("/api/fleet", fleetRoutes);
app.use("/api/fleet", trackerRoutes);
app.use("/api/device", deviceRoutes);
app.use("/api/routes", routeRoutes);
app.use("/api/geocode", geocodeRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/families", familyRoutes);
app.use("/api/members", memberRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/check", checkRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/data", dataRoutes);

app.get("/health", (_request, response) => {
  response.json({ status: "running" });
});

// Which web build this server is serving. Open tabs compare it with their own
// build and offer a reload after a deploy. null in development.
const frontendBuild = isProduction ? await readFrontendBuild() : null;
app.get("/api/version", (_request, response) => {
  response.json({ build: frontendBuild });
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

// Finishes trips the driver forgot to finish (10 min after the final stop).
const stopAutoFinish = startAutoFinish();

/** Redeploys send SIGTERM: stop accepting, end live streams, drain the pool. */
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAutoFinish();
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

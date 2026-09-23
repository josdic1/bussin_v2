import express from "express";
import { authRoutes } from "./auth/routes.js";
import { fleetRoutes } from "./fleet/routes.js";
import { routeRoutes } from "./routes/routes.js";
import { geocodeRoutes } from "./geocode/routes.js";

const app = express();

app.use(express.json({ limit: "32kb" }));
app.use("/api/auth", authRoutes);
app.use("/api/fleet", fleetRoutes);
app.use("/api/routes", routeRoutes);
app.use("/api/geocode", geocodeRoutes);

app.get("/health", (_request, response) => {
  response.json({ status: "running" });
});

const port = Number(process.env.PORT ?? 3001);

app.listen(port, process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Bussin server listening on port ${port}`);
});

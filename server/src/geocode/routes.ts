import { Router } from "express";
import { z } from "zod";
import { addressSearchResponseSchema } from "@bussin/shared";
import { requireRole } from "../auth/guard.js";

export const geocodeRoutes = Router();

const querySchema = z.string().trim().min(5).max(254);

const providerResponseSchema = z.object({
  results: z.array(z.object({
    formatted: z.string(),
    lat: z.number(),
    lon: z.number(),
    housenumber: z.string().optional(),
    street: z.string().optional()
  }).passthrough())
});

geocodeRoutes.get("/search", requireRole("admin"), async (request, response) => {
  const query = querySchema.safeParse(request.query.q);
  if (!query.success) {
    response.status(400).json({ error: "Enter an address or place to find." });
    return;
  }

  const key = process.env.GEOAPIFY_API_KEY;
  if (!key) {
    response.status(503).json({ error: "Address search is not configured yet." });
    return;
  }

  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.search = new URLSearchParams({
    text: query.data,
    format: "json",
    filter: "countrycode:us",
    limit: "5",
    apiKey: key
  }).toString();

  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      console.error("Geoapify rejected search; status:", upstream.status);
      response.status(502).json({ error: "Address search is unavailable." });
      return;
    }

    const data = providerResponseSchema.parse(await upstream.json());
    const results = data.results.flatMap((item) => {
      const parsed = addressSearchResponseSchema.shape.results.element.safeParse({
        label: item.formatted,
        latitude: item.lat,
        longitude: item.lon,
        locationType: item.housenumber && item.street ? "address" : "place"
      });
      return parsed.success ? [parsed.data] : [];
    });

    response.json(addressSearchResponseSchema.parse({ results }));
  } catch (error) {
    console.error("Geoapify search failed; type:",
      error instanceof Error ? error.name : "unknown");
    response.status(502).json({ error: "Address search is unavailable." });
  }
});

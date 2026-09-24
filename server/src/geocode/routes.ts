import { Router } from "express";
import { z } from "zod";
import { addressSearchResponseSchema } from "@bussin/shared";
import { requireRole } from "../auth/guard.js";

export const geocodeRoutes = Router();

const querySchema = z.string().trim().min(3).max(254);

const providerResponseSchema = z.object({
  results: z.array(z.object({
    formatted: z.string(),
    lat: z.number(),
    lon: z.number(),
    housenumber: z.string().optional(),
    street: z.string().optional()
  }).passthrough())
});

// Short-lived, bounded cache for repeated address queries. Failed lookups are never cached.
const suggestionsCache = new Map<string, {
  expiresAt: number;
  value: z.infer<typeof addressSearchResponseSchema>;
}>();

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

  const cacheKey = query.data.toLowerCase().replace(/\s+/g, " ");
  const cached = suggestionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    response.set("X-Geocode-Cache", "HIT").json(cached.value);
    return;
  }
  if (cached) suggestionsCache.delete(cacheKey);

  const url = new URL("https://api.geoapify.com/v1/geocode/autocomplete");
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

    const output = addressSearchResponseSchema.parse({ results });
    suggestionsCache.delete(cacheKey);
    suggestionsCache.set(cacheKey, { expiresAt: Date.now() + 120_000, value: output });
    if (suggestionsCache.size > 100) {
      const oldest = suggestionsCache.keys().next().value;
      if (oldest) suggestionsCache.delete(oldest);
    }
    response.set("X-Geocode-Cache", "MISS").json(output);
  } catch (error) {
    console.error("Geoapify search failed; type:",
      error instanceof Error ? error.name : "unknown");
    response.status(502).json({ error: "Address search is unavailable." });
  }
});

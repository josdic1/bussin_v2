import { existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Request, RequestHandler } from "express";

/** Baseline browser protections for every response. */
export const securityHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  });
  next();
};

/**
 * Serves the Vite build. Hashed files under /assets are immutable and are sent
 * pre-gzipped when the build produced a .gz twin; everything else revalidates.
 */
export function frontendStatic(distDirectory: string): RequestHandler {
  const root = normalize(distDirectory + sep);
  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") { next(); return; }
    if (!request.path.startsWith("/assets/")) { next(); return; }

    const file = normalize(join(root, decodeURIComponent(request.path)));
    if (!file.startsWith(root)) { next(); return; }

    response.set("Cache-Control", "public, max-age=31536000, immutable");
    response.vary("Accept-Encoding");
    if (request.acceptsEncodings("gzip") && existsSync(`${file}.gz`)) {
      response.type(extname(file));
      response.set("Content-Encoding", "gzip");
      response.sendFile(`${file}.gz`, { cacheControl: false, lastModified: true });
      return;
    }
    next();
  };
}

/** Only failed attempts count; a success clears the identity's counter. */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {
    const sweep = setInterval(() => this.sweep(), windowMs);
    sweep.unref();
  }

  private recent(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }

  /** Seconds until the key may try again, or 0 when allowed. */
  retryAfter(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    if (list.length < this.limit) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000));
  }

  fail(key: string, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  private sweep(now = Date.now()) {
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }
}

export function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}

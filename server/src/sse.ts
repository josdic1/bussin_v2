import type { Response } from "express";

const open = new Set<Response>();

/**
 * Starts a server-sent event stream. A comment ping every 25s keeps proxies
 * (Railway, Safari) from closing an idle stream. Returns a writer and a hook
 * that runs once when the stream closes for any reason.
 */
export function openStream(response: Response) {
  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders();
  open.add(response);

  const ping = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 25_000);
  ping.unref();

  const closers: (() => void)[] = [() => clearInterval(ping), () => open.delete(response)];
  response.on("close", () => { for (const close of closers.splice(0)) close(); });

  return {
    send(event: string, data: string) {
      if (!response.writableEnded) response.write(`event: ${event}\ndata: ${data}\n\n`);
    },
    onClose(close: () => void) {
      closers.push(close);
    }
  };
}

/** Ends every open stream so a redeploy can finish; clients reconnect on their own. */
export function closeAllStreams() {
  for (const response of open) response.end();
  open.clear();
}

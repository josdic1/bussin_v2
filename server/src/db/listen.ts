import type { PoolClient } from "pg";
import { pool } from "./pool.js";

type Subscriber = (payload: string) => void;

/**
 * One dedicated connection LISTENs on every channel the app uses. It connects
 * on the first subscriber and reconnects after a failure while anyone listens.
 */
const channels = new Map<string, Set<Subscriber>>();
let client: PoolClient | null = null;
let connecting: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function listening() {
  for (const set of channels.values()) if (set.size) return true;
  return false;
}

function scheduleReconnect() {
  if (reconnectTimer || !listening()) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnection();
  }, 1_000);
  reconnectTimer.unref();
}

function lose(failed: PoolClient) {
  if (client !== failed) return;
  client = null;
  try {
    failed.release(true);
  } catch {
    // Already released by pg.
  }
  scheduleReconnect();
}

async function ensureConnection() {
  if (client || connecting || !listening()) return;

  connecting = (async () => {
    const next = await pool.connect();
    try {
      next.on("notification", (notification) => {
        if (!notification.payload) return;
        for (const subscriber of channels.get(notification.channel) ?? []) {
          subscriber(notification.payload);
        }
      });
      next.on("error", () => lose(next));
      for (const channel of channels.keys()) await next.query(`LISTEN ${channel}`);
      client = next;
    } catch (error) {
      next.release(true);
      throw error;
    }
  })();

  try {
    await connecting;
  } catch {
    scheduleReconnect();
  } finally {
    connecting = null;
  }
}

export async function subscribe(channel: string, subscriber: Subscriber) {
  if (!/^[a-z_]+$/.test(channel)) throw new Error(`Invalid channel ${channel}`);
  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
    if (client) await client.query(`LISTEN ${channel}`).catch(() => lose(client!));
  }
  set.add(subscriber);
  await ensureConnection();
  return () => {
    set.delete(subscriber);
  };
}

/** Releases the listener connection during shutdown. */
export function closeListener() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  channels.clear();
  const current = client;
  client = null;
  current?.release(true);
}

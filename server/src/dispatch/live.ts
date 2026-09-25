import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";

const CHANNEL = "bussin_dispatch_location";
type Subscriber = (payload: string) => void;

const subscribers = new Set<Subscriber>();
let listenerClient: PoolClient | null = null;
let connecting: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect() {
  if (reconnectTimer || subscribers.size === 0) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureListener();
  }, 1_000);
  reconnectTimer.unref();
}

function loseListener(client: PoolClient) {
  if (listenerClient !== client) return;
  listenerClient = null;
  try {
    client.release(true);
  } catch {
    // The failed connection may already be released by pg.
  }
  scheduleReconnect();
}

async function ensureListener() {
  if (listenerClient || connecting || subscribers.size === 0) return;

  connecting = (async () => {
    const client = await pool.connect();
    try {
      client.on("notification", (notification) => {
        if (notification.channel !== CHANNEL || !notification.payload) return;
        for (const subscriber of subscribers) {
          subscriber(notification.payload);
        }
      });
      client.on("error", () => loseListener(client));
      await client.query(`LISTEN ${CHANNEL}`);
      listenerClient = client;
    } catch (error) {
      client.release(true);
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

export async function subscribeToDispatchLocations(subscriber: Subscriber) {
  subscribers.add(subscriber);
  await ensureListener();

  return () => {
    subscribers.delete(subscriber);
  };
}

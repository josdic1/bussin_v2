import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { pool } from "./db/pool.js";
import { createSession } from "./auth/sessions.js";
import { messageRoutes } from "./messages/routes.js";

test("driver messages enforce assignment, recipient isolation, fixed text and duplicate protection", async () => {
  const token = randomUUID().slice(0, 8);
  async function id(sql: string, values: unknown[] = []) {
    return (await pool.query<{ id: string }>(sql, values)).rows[0].id;
  }
  const driver = await id(`INSERT INTO members (email, display_name, password_hash, activated_at)
    VALUES ($1, 'Tablet Test', 'test-only', now()) RETURNING id`, [`tablet-${token}@example.test`]);
  await pool.query(`INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')`, [driver]);
  const family = await id(`INSERT INTO route_families (name) VALUES ($1) RETURNING id`, [`Tablet-${token}`]);
  const route = await id(`INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM') RETURNING id`, [`Tablet-${token}-AM`, family]);
  const bus = await id(`INSERT INTO buses (label) VALUES ($1) RETURNING id`, [`Tablet-${token}`]);
  const trip = await id(`INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now()) RETURNING id`, [route, bus]);
  const otherTrip = await id(`INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id`, [route, bus]);
  await pool.query(`INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)`, [trip, driver]);
  const stop = await id(`INSERT INTO route_stops (route_id, position, label, latitude, longitude)
    VALUES ($1, 1, 'School', 40.75, -74.25) RETURNING id`, [route]);
  const rider = await id(`INSERT INTO riders (given_name, family_name) VALUES ('Test', 'Rider') RETURNING id`);
  await pool.query(`INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id) VALUES ($1, 'AM', $2, $3)`, [rider, route, stop]);
  const guardian = await id(`INSERT INTO guardians (name) VALUES ('Tablet Guardian') RETURNING id`);
  const unrelated = await id(`INSERT INTO guardians (name) VALUES ('Unrelated Guardian') RETURNING id`);
  await pool.query(`INSERT INTO rider_guardian_links (rider_id, guardian_id, source) VALUES ($1, $2, 'manual')`, [rider, guardian]);
  const session = await createSession(driver);
  const app = express(); app.use(express.json()); app.use('/api/messages', messageRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  async function post(path: string, input: unknown, authenticated = true) {
    return fetch(base + '/api/messages/' + path, { method: 'POST', headers: {
      origin: base, 'content-type': 'application/json', ...(authenticated ? { cookie: `bussin_session=${session}` } : {})
    }, body: JSON.stringify(input) });
  }
  try {
    const input = { tripId: trip, preset: 'late5', clientMessageId: randomUUID() };
    assert.equal((await post('staff', input, false)).status, 401);
    assert.equal((await post('staff', { ...input, tripId: otherTrip })).status, 403);
    assert.equal((await post('staff', { ...input, body: 'unreviewed text' })).status, 400);
    const preview = await post('staff/preview', { tripId: trip });
    assert.equal(preview.status, 200); assert.equal((await preview.json()).guardians, 1);
    const first = await post('staff', input); assert.equal(first.status, 201);
    assert.equal((await first.json()).channel, 'in_app');
    const retry = await post('staff', input); assert.equal(retry.status, 200);
    assert.equal((await retry.json()).replayed, true);
    assert.equal((await post('staff', { ...input, preset: 'late10' })).status, 409);
    const recipients = await pool.query(`SELECT guardian_id FROM family_message_recipients WHERE message_id = $1`, [input.clientMessageId]);
    assert.deepEqual(recipients.rows.map(r => r.guardian_id), [guardian]);
    assert.ok(!recipients.rows.some(r => r.guardian_id === unrelated));
    // Concurrent identical sends must create exactly one additional row.
    const simultaneous = { ...input, clientMessageId: randomUUID() };
    const results = await Promise.all([post('staff', simultaneous), post('staff', simultaneous)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM family_messages WHERE id = $1`, [simultaneous.clientMessageId])).rows[0].count, 1);
    // Dispatch locks trip first, then ends its assignment. A simultaneous send
    // must wait and recheck, rather than deadlocking or using old authorization.
    const dispatch = await pool.connect();
    let racing: Promise<Response> | undefined;
    try {
      await dispatch.query("BEGIN");
      await dispatch.query(`SELECT id FROM trips WHERE id = $1 FOR UPDATE`, [trip]);
      racing = post('staff', { ...input, clientMessageId: randomUUID() });
      await dispatch.query("SELECT pg_sleep(0.05)");
      await dispatch.query(`UPDATE staff_assignments SET ended_at = now() WHERE member_id = $1`, [driver]);
      await dispatch.query("COMMIT");
    } catch (error) { await dispatch.query("ROLLBACK"); throw error; }
    finally { dispatch.release(); }
    assert.equal((await racing!).status, 403);
    assert.equal((await post('staff', { ...input, clientMessageId: randomUUID() })).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Remove only this test's records; never touch real tenant data.
    await pool.query(`DELETE FROM family_message_recipients WHERE message_id IN (SELECT id FROM family_messages WHERE sent_by = $1)`, [driver]);
    await pool.query(`DELETE FROM family_messages WHERE sent_by = $1`, [driver]);
    await pool.query(`DELETE FROM staff_assignments WHERE member_id = $1`, [driver]);
    await pool.query(`DELETE FROM sessions WHERE member_id = $1`, [driver]);
    await pool.query(`DELETE FROM rider_guardian_links WHERE rider_id = $1`, [rider]);
    await pool.query(`DELETE FROM rider_stop_assignments WHERE rider_id = $1`, [rider]);
    await pool.query(`DELETE FROM trips WHERE id = ANY($1::uuid[])`, [[trip, otherTrip]]);
    await pool.query(`DELETE FROM route_stops WHERE id = $1`, [stop]);
    await pool.query(`DELETE FROM routes WHERE id = $1`, [route]);
    await pool.query(`DELETE FROM route_families WHERE id = $1`, [family]);
    await pool.query(`DELETE FROM buses WHERE id = $1`, [bus]);
    await pool.query(`DELETE FROM riders WHERE id = $1`, [rider]);
    await pool.query(`DELETE FROM guardians WHERE id = ANY($1::uuid[])`, [[guardian, unrelated]]);
    await pool.query(`DELETE FROM member_roles WHERE member_id = $1`, [driver]);
    await pool.query(`DELETE FROM members WHERE id = $1`, [driver]);
    await pool.end();
  }
});

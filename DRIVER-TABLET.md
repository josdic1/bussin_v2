# Bussin driver terminal

This update replaces the existing staff screen. It uses the same signed-in staff account, assigned trips, location uploads, trip actions and family-message tables as the current app. There is no second database or parallel trip model.

## Open it

Deploy the frontend and backend from the same revision. On the tablet, open your existing Bussin URL and sign in with a staff-only driver account. Allow precise location, add Bussin to the home screen if the browser supports it, and tap **Keep screen on** if requested. A staff account automatically receives the driver screen. Admin/dispatch accounts retain their operations screens.

The tablet needs internet and working geolocation. A Wi-Fi-only tablet needs Wi-Fi or a hotspot while moving. Home-screen installation does not guarantee background GPS, Web Push support, or notification delivery. Keep the driver screen visible during a trip.

## What changed

- Responsive tablet layout with large buttons, readable type and local SVG icons.
- Sticky tracking banner showing trip state, GPS age/accuracy, server receipt age, accepted GPS sample age and screen wake protection.
- Green requires an active trip, visible app, reported internet connection, fresh trip confirmation, GPS accuracy within 35 m, a fresh accepted sample/receipt, empty upload queue and active wake lock. The 35 m value is a conservative display threshold; it does not change the existing server acceptance policy.
- A successful upload of an old queued sample does not imply live tracking.
- Quick, reviewed messages for 5/10-minute delays, an unspecified delay and service resuming. Preview displays linked guardians and how many have active family access.
- Server-authorized messaging only to the driver's currently assigned planned/active trip. Arbitrary audiences and custom message text are rejected.
- Admin and driver messages share the same transactional writer and recipient tables. Existing admin history shows driver sends.
- Message UUID survives uncertain retries in the current browser session. Same UUID and same payload returns the original result; different payload is rejected. Reassignment/end of trip blocks further driver sends.
- Driver messaging retains the existing motion lock. Controls are intended for a stopped bus or authorized aide.
- Unsent GPS entries now expire during runtime as well as on reload, using the existing 15-minute limit.

## Message delivery is explicit

Messages in this version are **in-app family inbox messages**. Twilio SMS is not connected. The uploaded service worker has no Web Push subscription, push handler or notification delivery implementation. The UI does not claim SMS/push delivery, parent receipt, or parent readership.

No Twilio secrets belong in frontend code. Connecting SMS later needs verified sender configuration, recipient consent/opt-out handling, server-side delivery jobs and actual provider delivery callbacks.

## Deploy to the existing service

The patch uses relative `/api` URLs and the existing session cookie. Use `npm run build` for the Railway build and `npm start` for the server start; preserve your existing environment and migration setup. The supplied railway.json specifies health checks but does not establish the dashboard's current build or pre-deploy settings. This update introduces no database migration or new runtime dependency.

If Netlify serves the frontend separately, deploy the matching frontend build and preserve the existing same-origin `/api` proxy to Railway. Do not replace it with cross-origin requests that drop the session cookie. The observed Netlify build command is `npm --workspace @bussin/frontend run build`. A frontend prebuild step now builds the shared workspace first, fixing the missing `@bussin/shared` build failure. Netlify API proxy configuration still requires separate confirmation.

## Verification

- Type checks and complete production build pass.
- Four tracking-state tests cover stale GPS/receipts, offline samples, inactive trips, backgrounding, denied location, poor accuracy and missing wake protection.
- Full server suite: 51 tests pass locally using an isolated PGlite PostgreSQL engine with a test-only pool adapter. This adapter is not part of the product. GitHub CI runs the suite against PostgreSQL 16.
- New HTTP integration test covers authentication, assigned-trip authorization, recipient isolation, fixed-text validation, retries, concurrent duplicate sends and revoked assignments.
- Browser checks use fixture API responses, not production families or production GPS. Hardware responsiveness, real device permissions, geolocation and cellular reconnection still require a tablet field test.

## Rollback

Revert the update commit and redeploy both services. Existing messages remain valid; there is no schema rollback. Do not reset the database.

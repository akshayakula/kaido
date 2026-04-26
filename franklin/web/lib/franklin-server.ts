// Resolve the URL of the franklin Flask server (the thing that talks to Lambda).
// Default port matches `franklin/server/app.py`'s deterministic-port convention
// for this kaido checkout.
export const FRANKLIN_SERVER_URL =
  process.env.FRANKLIN_SERVER_URL ?? 'http://127.0.0.1:3782';

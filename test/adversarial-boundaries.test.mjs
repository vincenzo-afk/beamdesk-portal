import assert from "node:assert/strict";
import test from "node:test";
import { app, eventTokens, sessions } from "../server.mjs";

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  sessions.clear();
  eventTokens.clear();
  server.close();
});

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  return { response, body: await response.json() };
}

async function createViewActiveSession() {
  const created = await api("/api/sessions", { method: "POST" });
  const operatorHeaders = { "x-session-token": created.body.token, "content-type": "application/json" };
  const joined = await api("/api/sessions/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: created.body.code }),
  });
  const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
  await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers: operatorHeaders });
  await api(`/api/sessions/${created.body.sessionId}/host-action`, {
    method: "POST",
    headers: hostHeaders,
    body: JSON.stringify({ action: "approve-view" }),
  });
  return { created, operatorHeaders, hostHeaders };
}

test("unknown API routes return a safe JSON response with portal security headers", async () => {
  const response = await fetch(`${base}/api/not-a-real-route`);
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.equal(body.error, "API route is unavailable.");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Object.hasOwn(body, "stack"), false);
});

test("live-event credentials cannot be replayed against another session or after expiry", async () => {
  const first = await api("/api/sessions", { method: "POST" });
  const second = await api("/api/sessions", { method: "POST" });
  const grant = await api(`/api/sessions/${first.body.sessionId}/event-token`, {
    method: "POST",
    headers: { "x-session-token": first.body.token },
  });
  const crossSession = await api(`/api/sessions/${second.body.sessionId}/events?access=${grant.body.accessToken}`);
  assert.equal(crossSession.response.status, 403);
  assert.equal(eventTokens.has(grant.body.accessToken), true);
  eventTokens.get(grant.body.accessToken).expiresAt = Date.now() - 1;
  const expired = await api(`/api/sessions/${first.body.sessionId}/events?access=${grant.body.accessToken}`);
  assert.equal(expired.response.status, 403);
});

test("invalid TURN HMAC configuration fails closed without producing a server error", async () => {
  const priorUrls = process.env.BEAMDESK_TURN_URLS;
  const priorSecret = process.env.BEAMDESK_TURN_SHARED_SECRET;
  const priorAlgorithm = process.env.BEAMDESK_TURN_HMAC_ALGORITHM;
  process.env.BEAMDESK_TURN_URLS = "turn:relay.example.test:3478";
  process.env.BEAMDESK_TURN_SHARED_SECRET = "test-turn-secret";
  process.env.BEAMDESK_TURN_HMAC_ALGORITHM = "not-a-hmac";
  try {
    const { created, operatorHeaders } = await createViewActiveSession();
    const ice = await api(`/api/sessions/${created.body.sessionId}/ice-config`, { headers: operatorHeaders });
    assert.equal(ice.response.status, 503);
    assert.equal(ice.body.error, "TURN relay credentials are not configured for this deployment.");
    const health = await api("/healthz");
    assert.equal(health.body.relay, "direct-only");
  } finally {
    if (priorUrls === undefined) delete process.env.BEAMDESK_TURN_URLS; else process.env.BEAMDESK_TURN_URLS = priorUrls;
    if (priorSecret === undefined) delete process.env.BEAMDESK_TURN_SHARED_SECRET; else process.env.BEAMDESK_TURN_SHARED_SECRET = priorSecret;
    if (priorAlgorithm === undefined) delete process.env.BEAMDESK_TURN_HMAC_ALGORITHM; else process.env.BEAMDESK_TURN_HMAC_ALGORITHM = priorAlgorithm;
  }
});

test("repeated TURN reads cannot grow a session audit record beyond its retained bound", async () => {
  const priorUrls = process.env.BEAMDESK_TURN_URLS;
  const priorSecret = process.env.BEAMDESK_TURN_SHARED_SECRET;
  delete process.env.BEAMDESK_TURN_HMAC_ALGORITHM;
  process.env.BEAMDESK_TURN_URLS = "turn:relay.example.test:3478";
  process.env.BEAMDESK_TURN_SHARED_SECRET = "test-turn-secret";
  try {
    const { created, operatorHeaders } = await createViewActiveSession();
    const session = sessions.get(created.body.sessionId);
    session.audit = Array.from({ length: 256 }, (_, index) => ({ at: index, event: `EVENT_${index}`, actor: "operator" }));
    const ice = await api(`/api/sessions/${created.body.sessionId}/ice-config`, { headers: operatorHeaders });
    assert.equal(ice.response.status, 200);
    assert.equal(session.audit.length, 256);
    assert.equal(session.audit[0].event, "EVENT_1");
    assert.equal(session.audit.at(-1).event, "TURN_CREDENTIAL_ISSUED");
  } finally {
    if (priorUrls === undefined) delete process.env.BEAMDESK_TURN_URLS; else process.env.BEAMDESK_TURN_URLS = priorUrls;
    if (priorSecret === undefined) delete process.env.BEAMDESK_TURN_SHARED_SECRET; else process.env.BEAMDESK_TURN_SHARED_SECRET = priorSecret;
  }
});

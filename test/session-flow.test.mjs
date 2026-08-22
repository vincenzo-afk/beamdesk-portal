import assert from "node:assert/strict";
import test from "node:test";
import { abuseReports, app, chatWindows, closeSubscribers, eventTokens, eventTokenWindows, expireSession, pruneRateWindows, pruneRoleRateWindows, purgeTerminalSession, rateWindows, sessions } from "../server.mjs";

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  return { response, body: await response.json() };
}

test("a code requires separate host approval for viewing and control", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  assert.equal(created.response.status, 201);
  assert.match(created.body.code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);

  const joined = await api("/api/sessions/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.body.code }) });
  assert.equal(joined.body.state, "HOST_JOINED");

  const operatorHeaders = { "x-session-token": created.body.token };
  const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
  const viewRequested = await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers: operatorHeaders });
  assert.equal(viewRequested.body.state, "VIEW_PENDING");

  const controlTooSoon = await api(`/api/sessions/${created.body.sessionId}/control-request`, { method: "POST", headers: operatorHeaders });
  assert.equal(controlTooSoon.response.status, 409);

  const viewApproved = await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-view" }) });
  assert.equal(viewApproved.body.state, "VIEW_ACTIVE");

  const controlRequested = await api(`/api/sessions/${created.body.sessionId}/control-request`, { method: "POST", headers: operatorHeaders });
  assert.equal(controlRequested.body.state, "CONTROL_PENDING");

  const controlApproved = await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-control" }) });
  assert.equal(controlApproved.body.state, "CONTROL_ACTIVE");
});

test("live-update credentials are single-use and scoped to an authenticated session", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const noGrant = await api(`/api/sessions/${created.body.sessionId}/event-token`, { method: "POST" });
  assert.equal(noGrant.response.status, 403);
  const grant = await api(`/api/sessions/${created.body.sessionId}/event-token`, { method: "POST", headers: { "x-session-token": created.body.token } });
  assert.ok(grant.body.accessToken);
  const missing = await fetch(`${base}/api/sessions/${created.body.sessionId}/events`);
  assert.equal(missing.status, 403);
  const eventResponse = await fetch(`${base}/api/sessions/${created.body.sessionId}/events?access=${grant.body.accessToken}`, { signal: AbortSignal.timeout(100) }).catch(() => null);
  assert.ok(eventResponse === null || eventResponse.status === 200);
});

test("live-event credential issuance is bounded per role and cleared with terminal session state", async () => {
  sessions.clear();
  eventTokenWindows.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const headers = { "x-session-token": created.body.token };
  for (let index = 0; index < 12; index += 1) {
    const issued = await api(`/api/sessions/${created.body.sessionId}/event-token`, { method: "POST", headers });
    assert.equal(issued.response.status, 200);
  }
  const limited = await api(`/api/sessions/${created.body.sessionId}/event-token`, { method: "POST", headers });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "60");
  assert.equal(eventTokenWindows.has(`${created.body.sessionId}:operator`), true);
  await api(`/api/sessions/${created.body.sessionId}/end`, { method: "POST", headers, body: "{}" });
  assert.equal(eventTokenWindows.has(`${created.body.sessionId}:operator`), false);
});

test("session-event heartbeat resources are cleared when the session closes", () => {
  const heartbeatTimer = setInterval(() => {}, 60_000);
  heartbeatTimer.unref();
  let ended = false;
  const subscriber = { heartbeatTimer, res: { end: () => { ended = true; } } };
  const session = { subscribers: new Set([subscriber]) };
  closeSubscribers(session);
  assert.equal(subscriber.heartbeatTimer, null);
  assert.equal(ended, true);
  assert.equal(session.subscribers.size, 0);
});

test("expired network rate windows are pruned instead of accumulating in portal memory", () => {
  rateWindows.clear();
  rateWindows.set("expired-network", { startedAt: 0, requests: 1 });
  rateWindows.set("active-network", { startedAt: 119_000, requests: 2 });
  assert.equal(pruneRateWindows(120_001), 1);
  assert.equal(rateWindows.has("expired-network"), false);
  assert.equal(rateWindows.has("active-network"), true);
});

test("opaque WebRTC signals are refused before view approval and accepted only for an active consented session", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const operatorHeaders = { "x-session-token": created.body.token, "content-type": "application/json" };
  const joined = await api("/api/sessions/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.body.code }) });
  assert.equal(joined.response.status, 200);
  const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
  const beforeApproval = await api(`/api/sessions/${created.body.sessionId}/signal`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ kind: "offer", payload: { type: "offer" } }) });
  assert.equal(beforeApproval.response.status, 409);
  await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers: operatorHeaders });
  await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-view" }) });
  const signal = await api(`/api/sessions/${created.body.sessionId}/signal`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ kind: "offer", payload: { type: "offer", sdp: "opaque" } }) });
  assert.equal(signal.response.status, 202);
  assert.equal(signal.body.sequence, 1);
});

test("WebRTC signaling is bounded per consented participant role", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const operatorHeaders = { "x-session-token": created.body.token, "content-type": "application/json" };
  const joined = await api("/api/sessions/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.body.code }) });
  const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
  await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers: operatorHeaders });
  await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-view" }) });
  for (let index = 0; index < 80; index += 1) {
    const relayed = await api(`/api/sessions/${created.body.sessionId}/signal`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ kind: "candidate", payload: { candidate: `candidate-${index}` } }) });
    assert.equal(relayed.response.status, 202);
  }
  const operatorLimited = await api(`/api/sessions/${created.body.sessionId}/signal`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ kind: "candidate", payload: { candidate: "candidate-over-limit" } }) });
  assert.equal(operatorLimited.response.status, 429);
  const hostStillAllowed = await api(`/api/sessions/${created.body.sessionId}/signal`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ kind: "answer", payload: { type: "answer" } }) });
  assert.equal(hostStillAllowed.response.status, 202);
});

test("ending or expiring a session invalidates its live event credentials and blocks subsequent access", async () => {
  sessions.clear();
  eventTokens.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const headers = { "x-session-token": created.body.token };
  assert.ok(sessions.get(created.body.sessionId).expiryTimer);
  const grant = await api(`/api/sessions/${created.body.sessionId}/event-token`, { method: "POST", headers });
  assert.ok(eventTokens.has(grant.body.accessToken));
  const ended = await api(`/api/sessions/${created.body.sessionId}/end`, { method: "POST", headers, body: "{}" });
  assert.equal(ended.body.state, "ENDED");
  assert.equal(eventTokens.has(grant.body.accessToken), false);
  const afterEnd = await api(`/api/sessions/${created.body.sessionId}`, { headers });
  assert.equal(afterEnd.response.status, 404);
  const replacement = await api("/api/sessions", { method: "POST" });
  const session = sessions.get(replacement.body.sessionId);
  expireSession(session, session.expiresAt);
  assert.equal(session.state, "EXPIRED");
});

test("terminal audit records are retained briefly then purged from portal memory", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const headers = { "x-session-token": created.body.token };
  const ended = await api(`/api/sessions/${created.body.sessionId}/end`, { method: "POST", headers, body: "{}" });
  assert.equal(ended.body.state, "ENDED");
  const terminalSession = sessions.get(created.body.sessionId);
  assert.ok(terminalSession.purgeTimer);
  const retainedAudit = await api(`/api/sessions/${created.body.sessionId}/audit`, { headers });
  assert.equal(retainedAudit.response.status, 200);
  assert.equal(purgeTerminalSession(terminalSession), true);
  assert.equal(sessions.has(created.body.sessionId), false);
  const purgedAudit = await api(`/api/sessions/${created.body.sessionId}/audit`, { headers });
  assert.equal(purgedAudit.response.status, 404);
});

test("remote input is accepted only from the operator after distinct control approval and only in a canonical form", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const operatorHeaders = { "x-session-token": created.body.token, "content-type": "application/json" };
  const joined = await api("/api/sessions/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.body.code }) });
  const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
  const payload = { sequence: 1, events: [{ kind: "move", x: 0.5, y: 0.5 }] };
  const beforeApproval = await api(`/api/sessions/${created.body.sessionId}/input`, { method: "POST", headers: operatorHeaders, body: JSON.stringify(payload) });
  assert.equal(beforeApproval.response.status, 409);
  await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers: operatorHeaders });
  await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-view" }) });
  await api(`/api/sessions/${created.body.sessionId}/control-request`, { method: "POST", headers: operatorHeaders });
  await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-control" }) });
  const hostAttempt = await api(`/api/sessions/${created.body.sessionId}/input`, { method: "POST", headers: hostHeaders, body: JSON.stringify(payload) });
  assert.equal(hostAttempt.response.status, 403);
  const invalid = await api(`/api/sessions/${created.body.sessionId}/input`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ sequence: 2, events: [{ kind: "key", code: "<script>", down: true }] }) });
  assert.equal(invalid.response.status, 400);
  const accepted = await api(`/api/sessions/${created.body.sessionId}/input`, { method: "POST", headers: operatorHeaders, body: JSON.stringify(payload) });
  assert.equal(accepted.response.status, 202);
  const replayed = await api(`/api/sessions/${created.body.sessionId}/input`, { method: "POST", headers: operatorHeaders, body: JSON.stringify(payload) });
  assert.equal(replayed.response.status, 409);
  const stale = await api(`/api/sessions/${created.body.sessionId}/input`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ ...payload, sequence: 0 }) });
  assert.equal(stale.response.status, 409);
  const next = await api(`/api/sessions/${created.body.sessionId}/input`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ ...payload, sequence: 2 }) });
  assert.equal(next.response.status, 202);
});

test("the public portal is non-embeddable and does not cache session-bearing responses", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("strict-transport-security"), /max-age=31536000/);
});

test("malformed session requests receive a safe JSON error without framework details", async () => {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-valid-json",
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.error, "Request body must be valid JSON.");
  assert.equal(Object.hasOwn(body, "stack"), false);
});

test("oversized JSON requests receive a safe 413 response instead of an internal error", async () => {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(17 * 1024) }),
  });
  const body = await response.json();
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.error, "Request body is too large.");
  assert.equal(Object.hasOwn(body, "stack"), false);
});

test("the public readiness endpoint is cache-safe and reveals no credentials", async () => {
  const response = await fetch(`${base}/healthz`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.status, "ok");
  assert.equal(body.service, "beamdesk-portal");
  assert.ok(["configured", "direct-only"].includes(body.relay));
  assert.equal(Object.hasOwn(body, "credential"), false);
});

test("an authenticated participant can retrieve the complete audit after a terminal session", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const headers = { "x-session-token": created.body.token, "content-type": "application/json" };
  await api(`/api/sessions/${created.body.sessionId}/end`, { method: "POST", headers, body: "{}" });
  const audit = await api(`/api/sessions/${created.body.sessionId}/audit`, { headers });
  assert.equal(audit.response.status, 200);
  assert.equal(audit.body.state, "ENDED");
  assert.deepEqual(audit.body.events.map((entry) => entry.event), ["SESSION_CREATED", "SESSION_ENDED"]);
  const unauthenticated = await api(`/api/sessions/${created.body.sessionId}/audit`);
  assert.equal(unauthenticated.response.status, 403);
});

test("TURN credentials are generated only after view approval and expire before the session", async () => {
  sessions.clear();
  const oldUrls = process.env.BEAMDESK_TURN_URLS;
  const oldSecret = process.env.BEAMDESK_TURN_SHARED_SECRET;
  process.env.BEAMDESK_TURN_URLS = "turn:relay.example.test:3478?transport=udp,turns:relay.example.test:5349?transport=tcp";
  process.env.BEAMDESK_TURN_SHARED_SECRET = "test-turn-secret";
  try {
    const created = await api("/api/sessions", { method: "POST" });
    const operatorHeaders = { "x-session-token": created.body.token, "content-type": "application/json" };
    const joined = await api("/api/sessions/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.body.code }) });
    const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
    const beforeView = await api(`/api/sessions/${created.body.sessionId}/ice-config`, { headers: operatorHeaders });
    assert.equal(beforeView.response.status, 409);
    await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers: operatorHeaders });
    await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-view" }) });
    const ice = await api(`/api/sessions/${created.body.sessionId}/ice-config`, { headers: operatorHeaders });
    assert.equal(ice.response.status, 200);
    assert.deepEqual(ice.body.iceServers[0].urls, process.env.BEAMDESK_TURN_URLS.split(","));
    assert.match(ice.body.iceServers[0].username, /^\d+:[0-9a-f-]+:operator$/);
    assert.ok(ice.body.expiresAt <= sessions.get(created.body.sessionId).expiresAt);
  } finally {
    if (oldUrls === undefined) delete process.env.BEAMDESK_TURN_URLS; else process.env.BEAMDESK_TURN_URLS = oldUrls;
    if (oldSecret === undefined) delete process.env.BEAMDESK_TURN_SHARED_SECRET; else process.env.BEAMDESK_TURN_SHARED_SECRET = oldSecret;
  }
});

test("a terminal session rejects renewed approval and TURN access while retaining its protected audit", async () => {
  sessions.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const headers = { "x-session-token": created.body.token, "content-type": "application/json" };
  await api(`/api/sessions/${created.body.sessionId}/end`, { method: "POST", headers, body: "{}" });
  const view = await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers });
  const turn = await api(`/api/sessions/${created.body.sessionId}/ice-config`, { headers });
  const audit = await api(`/api/sessions/${created.body.sessionId}/audit`, { headers });
  assert.equal(view.response.status, 404);
  assert.equal(turn.response.status, 404);
  assert.equal(audit.response.status, 200);
});

test("TURN fails closed when its server secret is not configured", async () => {
  sessions.clear();
  const oldUrls = process.env.BEAMDESK_TURN_URLS;
  const oldSecret = process.env.BEAMDESK_TURN_SHARED_SECRET;
  process.env.BEAMDESK_TURN_URLS = "turn:relay.example.test:3478";
  delete process.env.BEAMDESK_TURN_SHARED_SECRET;
  try {
    const created = await api("/api/sessions", { method: "POST" });
    const operatorHeaders = { "x-session-token": created.body.token, "content-type": "application/json" };
    const joined = await api("/api/sessions/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.body.code }) });
    const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
    await api(`/api/sessions/${created.body.sessionId}/view-request`, { method: "POST", headers: operatorHeaders });
    await api(`/api/sessions/${created.body.sessionId}/host-action`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ action: "approve-view" }) });
    const turn = await api(`/api/sessions/${created.body.sessionId}/ice-config`, { headers: operatorHeaders });
    assert.equal(turn.response.status, 503);
  } finally {
    if (oldUrls === undefined) delete process.env.BEAMDESK_TURN_URLS; else process.env.BEAMDESK_TURN_URLS = oldUrls;
    if (oldSecret === undefined) delete process.env.BEAMDESK_TURN_SHARED_SECRET; else process.env.BEAMDESK_TURN_SHARED_SECRET = oldSecret;
  }
});

test("session chat is role-scoped, live-delivered, bounded, rate-limited, and retained only with the terminal session record", async () => {
  sessions.clear();
  chatWindows.clear();
  const created = await api("/api/sessions", { method: "POST" });
  const operatorHeaders = { "x-session-token": created.body.token, "content-type": "application/json" };
  const beforeJoin = await api(`/api/sessions/${created.body.sessionId}/chat`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ text: "Can you see this?" }) });
  assert.equal(beforeJoin.response.status, 409);

  const joined = await api("/api/sessions/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: created.body.code }) });
  const hostHeaders = { "x-session-token": joined.body.token, "content-type": "application/json" };
  const session = sessions.get(created.body.sessionId);
  const liveEvents = [];
  session.subscribers.add({ res: { write: (chunk) => liveEvents.push(chunk), end: () => {} }, heartbeatTimer: null });

  const sent = await api(`/api/sessions/${created.body.sessionId}/chat`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ text: "  Hello host\r\nCan you see the screen?  " }) });
  assert.equal(sent.response.status, 201);
  assert.equal(sent.body.message.from, "operator");
  assert.equal(sent.body.message.text, "Hello host\nCan you see the screen?");
  assert.ok(liveEvents.some((chunk) => chunk.includes("event: chat") && chunk.includes("Hello host")));

  const reply = await api(`/api/sessions/${created.body.sessionId}/chat`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ text: "Yes, I can." }) });
  assert.equal(reply.response.status, 201);
  const transcript = await api(`/api/sessions/${created.body.sessionId}/chat`, { headers: hostHeaders });
  assert.equal(transcript.response.status, 200);
  assert.deepEqual(transcript.body.messages.map((message) => message.text), ["Hello host\nCan you see the screen?", "Yes, I can."]);
  const unauthenticated = await api(`/api/sessions/${created.body.sessionId}/chat`);
  assert.equal(unauthenticated.response.status, 403);
  const blank = await api(`/api/sessions/${created.body.sessionId}/chat`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ text: "   " }) });
  assert.equal(blank.response.status, 400);

  session.chat = Array.from({ length: 80 }, (_, index) => ({ id: `existing-${index}`, at: index, from: "host", text: `Existing ${index}` }));
  const bounded = await api(`/api/sessions/${created.body.sessionId}/chat`, { method: "POST", headers: hostHeaders, body: JSON.stringify({ text: "Newest" }) });
  assert.equal(bounded.response.status, 201);
  assert.equal(session.chat.length, 80);
  assert.equal(session.chat[0].id, "existing-1");
  assert.equal(session.chat.at(-1).text, "Newest");

  for (let index = 0; index < 19; index += 1) {
    const message = await api(`/api/sessions/${created.body.sessionId}/chat`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ text: `Message ${index}` }) });
    assert.equal(message.response.status, 201);
  }
  const limited = await api(`/api/sessions/${created.body.sessionId}/chat`, { method: "POST", headers: operatorHeaders, body: JSON.stringify({ text: "Message over limit" }) });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "10");
  assert.equal(chatWindows.has(`${created.body.sessionId}:operator`), true);

  await api(`/api/sessions/${created.body.sessionId}/end`, { method: "POST", headers: operatorHeaders, body: "{}" });
  const retained = await api(`/api/sessions/${created.body.sessionId}/chat`, { headers: hostHeaders });
  assert.equal(retained.response.status, 200);
  assert.equal(retained.body.state, "ENDED");
  const terminalSession = sessions.get(created.body.sessionId);
  assert.equal(purgeTerminalSession(terminalSession), true);
  const purged = await api(`/api/sessions/${created.body.sessionId}/chat`, { headers: hostHeaders });
  assert.equal(purged.response.status, 404);
});

test("stale role-scoped rate windows are pruned for idle sessions", () => {
  chatWindows.clear();
  chatWindows.set("old:operator", { startedAt: 0, count: 1 });
  chatWindows.set("current:host", { startedAt: 15_000, count: 1 });
  assert.equal(pruneRoleRateWindows(20_001), 1);
  assert.equal(chatWindows.has("old:operator"), false);
  assert.equal(chatWindows.has("current:host"), true);
});

test("session creation is capped per network and an abuse report terminates the current session", async () => {
  sessions.clear();
  rateWindows.clear();
  abuseReports.length = 0;
  const created = [];
  for (let index = 0; index < 4; index += 1) created.push(await api("/api/sessions", { method: "POST" }));
  assert.ok(created.every((result) => result.response.status === 201));
  const limited = await api("/api/sessions", { method: "POST" });
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
  const first = created[0];
  const report = await api(`/api/sessions/${first.body.sessionId}/report-abuse`, {
    method: "POST",
    headers: { "x-session-token": first.body.token, "content-type": "application/json" },
    body: JSON.stringify({ category: "security_concern", details: "Unexpected activity" }),
  });
  assert.equal(report.response.status, 202);
  assert.equal(abuseReports.length, 1);
  assert.equal(sessions.get(first.body.sessionId).state, "ENDED");
});

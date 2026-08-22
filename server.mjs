import crypto from "node:crypto";
import express from "express";

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const TURN_CREDENTIAL_TTL_MS = 5 * 60 * 1000;
export const TERMINAL_SESSION_RETENTION_MS = 60 * 60 * 1000;
export const MAX_ACTIVE_SESSIONS_PER_IP = 4;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.BEAMDESK_TRUST_PROXY === "true" ? 1 : false);
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https: wss: stun: turn:; worker-src 'self' blob:; frame-src 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
});
app.use(express.json({ limit: "16kb" }));
app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    service: "beamdesk-portal",
    relay: process.env.BEAMDESK_TURN_SHARED_SECRET && configuredTurnUrls().length ? "configured" : "direct-only",
  });
});
app.use(express.static("public"));

const sessions = new Map();
const rateWindows = new Map();
const eventTokens = new Map();
const inputWindows = new Map();
const abuseReports = [];

function makeToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export function makeSupportCode(randomBytes = crypto.randomBytes(10)) {
  let value = BigInt(`0x${randomBytes.toString("hex")}`);
  let output = "";
  for (let index = 0; index < 16; index += 1) {
    output = CODE_ALPHABET[Number(value % BigInt(CODE_ALPHABET.length))] + output;
    value /= BigInt(CODE_ALPHABET.length);
  }
  return output.match(/.{1,4}/g).join("-");
}

function codeDigest(code) {
  return crypto.createHash("sha256").update(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()).digest("hex");
}

function safeTokenMatch(candidate, expected) {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function publicSession(session, role) {
  const canOperate = role === "operator";
  const canHost = role === "host";
  return {
    sessionId: session.id,
    state: session.state,
    expiresAt: session.expiresAt,
    role,
    capabilities: {
      canRequestView: canOperate && session.state === "HOST_JOINED",
      canRequestControl: canOperate && session.state === "VIEW_ACTIVE",
      canApproveView: canHost && session.state === "VIEW_PENDING",
      canApproveControl: canHost && session.state === "CONTROL_PENDING",
      canEnd: canOperate || canHost,
    },
    audit: session.audit.slice(-8),
  };
}

function addAudit(session, event, actor) {
  session.audit.push({ at: Date.now(), event, actor });
}

function publish(session) {
  for (const subscriber of session.subscribers) {
    subscriber.res.write(`event: session\ndata: ${JSON.stringify(publicSession(session, subscriber.role))}\n\n`);
  }
}

function publishSignal(session, recipientRole, envelope) {
  for (const subscriber of session.subscribers) {
    if (subscriber.role === recipientRole) subscriber.res.write(`event: signal\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
}

function publishInput(session, envelope) {
  for (const subscriber of session.subscribers) {
    if (subscriber.role === "host") subscriber.res.write(`event: input\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
}

function invalidateEventTokens(sessionId) {
  for (const [accessToken, grant] of eventTokens.entries()) {
    if (grant.sessionId === sessionId) eventTokens.delete(accessToken);
  }
}

function closeSubscribers(session) {
  for (const subscriber of session.subscribers) subscriber.res.end();
  session.subscribers.clear();
}

function inputRateLimited(sessionId) {
  const now = Date.now();
  const window = inputWindows.get(sessionId) || { startedAt: now, count: 0 };
  if (now - window.startedAt >= 1000) { window.startedAt = now; window.count = 0; }
  window.count += 1;
  inputWindows.set(sessionId, window);
  return window.count > 120;
}

function validInputPayload(payload) {
  if (!payload || !Number.isSafeInteger(payload.sequence) || payload.sequence < 0 || !Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 64) return false;
  return payload.events.every((event) => {
    if (!event || typeof event !== "object") return false;
    if (event.kind === "move") return Number.isFinite(event.x) && Number.isFinite(event.y) && event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1;
    if (event.kind === "button") return ["left", "middle", "right"].includes(event.button) && typeof event.down === "boolean";
    if (event.kind === "key") return typeof event.code === "string" && /^[A-Za-z0-9]{1,32}$/.test(event.code) && typeof event.down === "boolean";
    if (event.kind === "wheel") return Number.isFinite(event.deltaX) && Number.isFinite(event.deltaY) && Math.abs(event.deltaX) <= 1000 && Math.abs(event.deltaY) <= 1000;
    return false;
  });
}

function transition(session, state, event, actor) {
  session.state = state;
  addAudit(session, event, actor);
  publish(session);
}

function scheduleExpiry(session) {
  session.expiryTimer = setTimeout(() => expireSession(session), Math.max(1, session.expiresAt - Date.now()));
  session.expiryTimer.unref();
}

function scheduleTerminalPurge(session) {
  session.purgeTimer = setTimeout(() => purgeTerminalSession(session), TERMINAL_SESSION_RETENTION_MS);
  session.purgeTimer.unref();
}

export function purgeTerminalSession(session) {
  if (!session || !["ENDED", "EXPIRED"].includes(session.state)) return false;
  if (session.purgeTimer) clearTimeout(session.purgeTimer);
  invalidateEventTokens(session.id);
  inputWindows.delete(session.id);
  sessions.delete(session.id);
  return true;
}

export function terminateSession(session, state, event, actor) {
  if (["ENDED", "EXPIRED"].includes(session.state)) return;
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  transition(session, state, event, actor);
  invalidateEventTokens(session.id);
  inputWindows.delete(session.id);
  closeSubscribers(session);
  scheduleTerminalPurge(session);
}

export function expireSession(session, now = Date.now()) {
  if (session.expiresAt <= now && !["ENDED", "EXPIRED"].includes(session.state)) terminateSession(session, "EXPIRED", "SESSION_EXPIRED", "system");
}

function findSessionByCode(code) {
  const digest = codeDigest(code);
  return Array.from(sessions.values()).find((session) => session.codeDigest === digest);
}

function getRole(session, token) {
  if (safeTokenMatch(token, session.operatorToken)) return "operator";
  if (safeTokenMatch(token, session.hostToken)) return "host";
  return null;
}

function requireSession(req, res) {
  const session = sessions.get(req.params.id);
  if (session) expireSession(session);
  if (!session || ["ENDED", "EXPIRED"].includes(session.state)) {
    res.status(404).json({ error: "Session is unavailable." });
    return null;
  }
  const role = getRole(session, req.get("x-session-token"));
  if (!role) {
    res.status(403).json({ error: "Session authorization is required." });
    return null;
  }
  return { session, role };
}

function requireAuditSession(req, res) {
  const session = sessions.get(req.params.id);
  if (session) expireSession(session);
  if (!session) {
    res.status(404).json({ error: "Session is unavailable." });
    return null;
  }
  const role = getRole(session, req.get("x-session-token"));
  if (!role) {
    res.status(403).json({ error: "Session authorization is required." });
    return null;
  }
  return { session, role };
}

function rateLimited(req) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const window = rateWindows.get(key) || { startedAt: now, requests: 0 };
  if (now - window.startedAt > 60_000) {
    window.startedAt = now;
    window.requests = 0;
  }
  window.requests += 1;
  rateWindows.set(key, window);
  return window.requests > 18;
}

function activeSessionsFromIp(ip) {
  const now = Date.now();
  let count = 0;
  for (const session of sessions.values()) {
    if (session.expiresAt <= now) expireSession(session, now);
    if (session.createdByIp === ip && !["ENDED", "EXPIRED"].includes(session.state)) count += 1;
  }
  return count;
}

function sendRateLimit(res, error, retryAfterSeconds) {
  res.set("Retry-After", String(retryAfterSeconds));
  return res.status(429).json({ error, retryAfterSeconds });
}

function sessionCanUseTurn(session) {
  return ["VIEW_ACTIVE", "CONTROL_PENDING", "CONTROL_ACTIVE"].includes(session.state);
}

function configuredTurnUrls() {
  return String(process.env.BEAMDESK_TURN_URLS || "").split(",").map((value) => value.trim()).filter((value) => /^turns?:/i.test(value));
}

function makeTurnConfiguration(session, role) {
  const urls = configuredTurnUrls();
  const secret = process.env.BEAMDESK_TURN_SHARED_SECRET;
  if (!secret || !urls.length) return null;
  const expiresAt = Math.min(session.expiresAt, Date.now() + TURN_CREDENTIAL_TTL_MS);
  const username = `${Math.floor(expiresAt / 1000)}:${session.id}:${role}`;
  const algorithm = process.env.BEAMDESK_TURN_HMAC_ALGORITHM || "sha1";
  const credential = crypto.createHmac(algorithm, secret).update(username).digest("base64");
  return { iceServers: [{ urls, username, credential, credentialType: "password" }], expiresAt };
}

app.post("/api/sessions", (req, res) => {
  const ip = req.ip || "unknown";
  if (rateLimited(req)) return sendRateLimit(res, "Please wait before creating another support code.", 60);
  if (activeSessionsFromIp(ip) >= MAX_ACTIVE_SESSIONS_PER_IP) return sendRateLimit(res, "Too many active support codes were created from this network. End or wait for an existing code before creating another.", Math.ceil(SESSION_TTL_MS / 1000));
  let code;
  do code = makeSupportCode(); while (findSessionByCode(code));
  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    createdByIp: ip,
    codeDigest: codeDigest(code),
    operatorToken: makeToken(),
    hostToken: null,
    state: "CREATED",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    audit: [],
    subscribers: new Set(),
    signalSequence: 0,
    expiryTimer: null,
    purgeTimer: null,
  };
  addAudit(session, "SESSION_CREATED", "operator");
  sessions.set(session.id, session);
  scheduleExpiry(session);
  return res.status(201).json({ sessionId: session.id, code, token: session.operatorToken, expiresAt: session.expiresAt });
});

app.post("/api/sessions/join", (req, res) => {
  if (rateLimited(req)) return sendRateLimit(res, "Please wait before trying another code.", 60);
  const code = String(req.body?.code || "");
  const session = findSessionByCode(code);
  if (!session || session.expiresAt <= Date.now() || session.state !== "CREATED") return res.status(400).json({ error: "This support code is invalid, already used, or expired." });
  session.hostToken = makeToken();
  transition(session, "HOST_JOINED", "HOST_JOINED", "host");
  return res.json({ sessionId: session.id, token: session.hostToken, state: session.state, expiresAt: session.expiresAt });
});

app.get("/api/sessions/:id", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  return res.json(publicSession(context.session, context.role));
});

app.get("/api/sessions/:id/audit", (req, res) => {
  const context = requireAuditSession(req, res);
  if (!context) return;
  return res.json({ sessionId: context.session.id, state: context.session.state, events: context.session.audit });
});

app.get("/api/sessions/:id/ice-config", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  if (!sessionCanUseTurn(context.session)) return res.status(409).json({ error: "TURN credentials are unavailable until screen viewing is approved." });
  const configuration = makeTurnConfiguration(context.session, context.role);
  if (!configuration) return res.status(503).json({ error: "TURN relay credentials are not configured for this deployment." });
  addAudit(context.session, "TURN_CREDENTIAL_ISSUED", context.role);
  return res.json(configuration);
});

app.post("/api/sessions/:id/event-token", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  const expiresAt = Math.min(context.session.expiresAt, Date.now() + 60_000);
  const accessToken = makeToken();
  eventTokens.set(accessToken, { sessionId: context.session.id, role: context.role, expiresAt });
  return res.json({ accessToken, expiresAt });
});

app.get("/api/sessions/:id/events", (req, res) => {
  const accessToken = String(req.query.access || "");
  const grant = eventTokens.get(accessToken);
  const session = sessions.get(req.params.id);
  if (!grant || !session || grant.sessionId !== session.id || grant.expiresAt <= Date.now()) return res.status(403).json({ error: "A current event credential is required." });
  eventTokens.delete(accessToken);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  res.flushHeaders();
  const subscriber = { res, role: grant.role };
  session.subscribers.add(subscriber);
  res.write(`event: session\ndata: ${JSON.stringify(publicSession(session, grant.role))}\n\n`);
  req.on("close", () => session.subscribers.delete(subscriber));
});

app.post("/api/sessions/:id/view-request", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  if (context.role !== "operator" || context.session.state !== "HOST_JOINED") return res.status(409).json({ error: "Screen viewing cannot be requested in the current session state." });
  transition(context.session, "VIEW_PENDING", "VIEW_REQUESTED", "operator");
  return res.json(publicSession(context.session, context.role));
});

app.post("/api/sessions/:id/control-request", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  if (context.role !== "operator" || context.session.state !== "VIEW_ACTIVE") return res.status(409).json({ error: "Remote control cannot be requested before viewing is approved." });
  transition(context.session, "CONTROL_PENDING", "CONTROL_REQUESTED", "operator");
  return res.json(publicSession(context.session, context.role));
});

app.post("/api/sessions/:id/signal", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  if (!["VIEW_ACTIVE", "CONTROL_PENDING", "CONTROL_ACTIVE"].includes(context.session.state)) return res.status(409).json({ error: "WebRTC signaling is unavailable until the Windows host approves screen viewing." });
  const kind = String(req.body?.kind || "");
  const payload = req.body?.payload;
  if (!["offer", "answer", "candidate"].includes(kind) || !payload || typeof payload !== "object") return res.status(400).json({ error: "A valid opaque WebRTC signaling envelope is required." });
  const recipientRole = context.role === "operator" ? "host" : "operator";
  const envelope = { sequence: ++context.session.signalSequence, from: context.role, kind, payload, expiresAt: context.session.expiresAt };
  publishSignal(context.session, recipientRole, envelope);
  return res.status(202).json({ accepted: true, sequence: envelope.sequence });
});

app.post("/api/sessions/:id/input", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  if (context.role !== "operator") return res.status(403).json({ error: "Only the approved operator can send remote input." });
  if (context.session.state !== "CONTROL_ACTIVE") return res.status(409).json({ error: "Remote input is disabled until the Windows host approves control." });
  if (inputRateLimited(context.session.id)) return res.status(429).json({ error: "Remote input is temporarily rate-limited." });
  if (!validInputPayload(req.body)) return res.status(400).json({ error: "The remote input payload is invalid." });
  publishInput(context.session, { sequence: req.body.sequence, events: req.body.events, expiresAt: context.session.expiresAt });
  return res.status(202).json({ accepted: true });
});

app.post("/api/sessions/:id/host-action", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  const action = req.body?.action;
  if (context.role !== "host") return res.status(403).json({ error: "Only the Windows host can approve or deny a request." });
  if (action === "approve-view" && context.session.state === "VIEW_PENDING") transition(context.session, "VIEW_ACTIVE", "APPROVE_VIEW", "host");
  else if (action === "deny-view" && context.session.state === "VIEW_PENDING") transition(context.session, "HOST_JOINED", "DENY_VIEW", "host");
  else if (action === "approve-control" && context.session.state === "CONTROL_PENDING") transition(context.session, "CONTROL_ACTIVE", "APPROVE_CONTROL", "host");
  else if (action === "deny-control" && context.session.state === "CONTROL_PENDING") transition(context.session, "VIEW_ACTIVE", "DENY_CONTROL", "host");
  else if (action === "revoke-control" && ["CONTROL_ACTIVE", "CONTROL_PENDING"].includes(context.session.state)) transition(context.session, "VIEW_ACTIVE", "REVOKE_CONTROL", "host");
  else return res.status(409).json({ error: "That approval action is not available now." });
  return res.json(publicSession(context.session, context.role));
});

app.post("/api/sessions/:id/end", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  terminateSession(context.session, "ENDED", "SESSION_ENDED", context.role);
  return res.json({ state: "ENDED" });
});

app.post("/api/sessions/:id/report-abuse", (req, res) => {
  const context = requireSession(req, res);
  if (!context) return;
  const category = String(req.body?.category || "");
  if (!["unexpected_control", "harassment", "security_concern", "other"].includes(category)) return res.status(400).json({ error: "Select a supported abuse-report category." });
  const details = String(req.body?.details || "").trim().slice(0, 500);
  abuseReports.push({ sessionId: context.session.id, at: Date.now(), actor: context.role, category, details });
  if (abuseReports.length > 1000) abuseReports.shift();
  addAudit(context.session, "ABUSE_REPORTED", context.role);
  terminateSession(context.session, "ENDED", "SESSION_ENDED_AFTER_ABUSE_REPORT", context.role);
  return res.status(202).json({ reported: true, state: "ENDED" });
});

export { app, sessions, codeDigest, eventTokens, rateWindows, abuseReports };

if (process.env.RUN_PORTAL_SERVER === "true") {
  const port = Number(process.env.PORT || 4173);
  app.listen(port, () => console.log(`BeamDesk portal available on port ${port}`));
}

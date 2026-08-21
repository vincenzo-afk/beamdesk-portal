const storageKey = "beamdesk-current-session";
let current = JSON.parse(sessionStorage.getItem(storageKey) || "null");
let eventSource = null;
let viewerPeer = null;
let viewerStream = null;
let inputAbort = null;
let inputQueue = [];
let inputFlushTimer = null;
let inputSequence = 0;

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(current ? { "x-session-token": current.token } : {}), ...(options.headers || {}) }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

function saveCurrent(value) {
  current = value;
  if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
  else sessionStorage.removeItem(storageKey);
}

function stopEvents() {
  eventSource?.close();
  eventSource = null;
}

function clearViewer() {
  clearInputBindings();
  viewerPeer?.close();
  viewerPeer = null;
  viewerStream?.getTracks().forEach((track) => track.stop());
  viewerStream = null;
}

function clearInputBindings() {
  inputAbort?.abort();
  inputAbort = null;
  inputQueue = [];
  if (inputFlushTimer) window.clearTimeout(inputFlushTimer);
  inputFlushTimer = null;
}

function attachViewer() {
  const video = document.querySelector("#remote-view");
  if (video && viewerStream) video.srcObject = viewerStream;
}

function screen(template) {
  app.innerHTML = template;
}

function home(error = "") {
  stopEvents();
  clearViewer();
  screen(`<section class="hero"><div><p class="eyebrow">REMOTE SUPPORT, WITH CONSENT</p><h1>Help a person remotely—<em>only when they say yes.</em></h1><p class="lede">Create a short-lived support code or enter one you received. The person at the host computer approves viewing and remote control separately.</p><div class="trust-row"><span>One-time code</span><span>Host approval</span><span>End anytime</span></div></div><div class="card choice-card"><div class="card-heading"><p class="eyebrow">START A SESSION</p><h2>What do you need?</h2></div><button id="create" class="primary">Create support code <span>→</span></button><div class="divider"><span>or</span></div><label class="field-label" for="code">Join from a host device</label><div class="join-row"><input id="code" autocomplete="one-time-code" maxlength="19" placeholder="ABCD-EFGH-JKLM-NPQR" /><button id="join" class="secondary">Join</button></div><p class="fineprint">Joining a code does not share a screen or enable remote control. The person at the host computer will approve each permission locally.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}</div></section>`);
  document.querySelector("#create").onclick = createSession;
  document.querySelector("#join").onclick = joinSession;
  document.querySelector("#code").oninput = (event) => {
    const raw = event.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 16);
    event.target.value = raw.match(/.{1,4}/g)?.join("-") || raw;
  };
}

async function createSession() {
  try {
    const session = await request("/api/sessions", { method: "POST", body: "{}" });
    saveCurrent({ id: session.sessionId, token: session.token, role: "operator", code: session.code });
    sessionView();
  } catch (error) { home(error.message); }
}

async function joinSession() {
  try {
    const code = document.querySelector("#code").value;
    const session = await request("/api/sessions/join", { method: "POST", body: JSON.stringify({ code, agentNonce: crypto.randomUUID() }) });
    saveCurrent({ id: session.sessionId, token: session.token, role: "host" });
    sessionView();
  } catch (error) { home(error.message); }
}

function stateCopy(state, role) {
  const labels = {
    CREATED: ["Waiting for host device", "Share the code with the person at the computer that needs help. It expires in 10 minutes."],
    HOST_JOINED: role === "operator" ? ["Host device is connected", "Request permission to view the selected display."] : ["You joined the support session", "Open the signed BeamDesk host app to approve any request locally."],
    VIEW_PENDING: ["Waiting for view approval", "The host is deciding whether to share a display."],
    VIEW_ACTIVE: ["Screen viewing approved", "Remote control is still disabled. Request it separately if needed."],
    CONTROL_PENDING: ["Waiting for control approval", "The host must approve keyboard and pointer input locally."],
    CONTROL_ACTIVE: ["Remote control active", "The host can pause control, stop sharing, or end the session at any time."],
  };
  return labels[state] || ["Session unavailable", "This support session has ended or expired."];
}

async function sessionView() {
  if (!current) return home();
  try {
    const session = await request(`/api/sessions/${current.id}`);
    renderSession(session);
    subscribeToSession();
  } catch (error) { saveCurrent(null); home(error.message); }
}

function renderSession(session) {
  const [title, description] = stateCopy(session.state, current.role);
  const isOperator = current.role === "operator";
  const viewGranted = ["VIEW_ACTIVE", "CONTROL_PENDING", "CONTROL_ACTIVE"].includes(session.state);
  const controlGranted = isOperator && session.state === "CONTROL_ACTIVE";
  clearInputBindings();
  const viewerMarkup = isOperator && viewGranted
    ? `<div class="stream-placeholder approved viewer-surface ${controlGranted ? "control-enabled" : ""}"><video id="remote-view" autoplay playsinline tabindex="0" aria-label="Approved host display stream"></video><p class="viewer-note">${controlGranted ? "Remote control active — click the view to focus input. The host can pause control at any time." : "Awaiting the host’s encrypted display stream."}</p></div>`
    : `<div class="stream-placeholder"><span class="screen-icon">▣</span><p>${viewGranted ? "The host may share a display only through the signed BeamDesk host app." : "No screen is being shared."}</p></div>`;
  screen(`<section class="session-layout"><div class="session-main"><p class="eyebrow">${isOperator ? "OPERATOR CONSOLE" : "HOST JOIN"}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(description)}</p>${isOperator && current.code ? `<div class="code-box"><p>Support code</p><strong>${escapeHtml(current.code)}</strong><button id="copy" class="text-button">Copy code</button></div>` : ""}${viewerMarkup}</div><aside class="card status-card"><p class="eyebrow">SESSION STATUS</p><div class="status-line"><span class="pulse ${session.state.includes("ACTIVE") ? "active" : ""}"></span><strong>${escapeHtml(session.state.replace("_", " "))}</strong></div><p class="expires">Expires ${new Date(session.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p><div class="actions">${session.capabilities.canRequestView ? '<button id="request-view" class="primary">Request screen view</button>' : ""}${session.capabilities.canRequestControl ? '<button id="request-control" class="primary">Request remote control</button>' : ""}${session.capabilities.canApproveView ? '<button id="approve-view" class="primary">Approve screen view</button><button id="deny-view" class="secondary">Decline</button>' : ""}${session.capabilities.canApproveControl ? '<button id="approve-control" class="primary">Approve remote control</button><button id="deny-control" class="secondary">Keep view only</button>' : ""}${session.state === "CONTROL_ACTIVE" && !isOperator ? '<button id="revoke" class="secondary danger">Pause remote control</button>' : ""}<button id="audit-history" class="text-button">View full audit history</button><button id="report-abuse" class="text-button danger-text">Report a security concern and end</button><button id="end" class="text-button">End session</button></div><div class="audit"><p>Recent events</p>${session.audit.map((event) => `<small>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${escapeHtml(event.event.replaceAll("_", " "))}</small>`).join("")}</div></aside></section>`);
  document.querySelector("#copy")?.addEventListener("click", () => navigator.clipboard.writeText(current.code));
  document.querySelector("#request-view")?.addEventListener("click", () => action("view-request"));
  document.querySelector("#request-control")?.addEventListener("click", () => action("control-request"));
  document.querySelector("#approve-view")?.addEventListener("click", () => hostAction("approve-view"));
  document.querySelector("#deny-view")?.addEventListener("click", () => hostAction("deny-view"));
  document.querySelector("#approve-control")?.addEventListener("click", () => hostAction("approve-control"));
  document.querySelector("#deny-control")?.addEventListener("click", () => hostAction("deny-control"));
  document.querySelector("#revoke")?.addEventListener("click", () => hostAction("revoke-control"));
  document.querySelector("#audit-history")?.addEventListener("click", showAuditHistory);
  document.querySelector("#report-abuse")?.addEventListener("click", reportSecurityConcern);
  document.querySelector("#end")?.addEventListener("click", endSession);
  if (isOperator && viewGranted) startViewer(controlGranted);
  else clearViewer();
}

async function sendSignal(kind, payload) {
  await request(`/api/sessions/${current.id}/signal`, { method: "POST", body: JSON.stringify({ kind, payload }) });
}

async function getIceConfiguration() {
  try {
    return await request(`/api/sessions/${current.id}/ice-config`);
  } catch (error) {
    console.warn("TURN relay credentials are unavailable; trying direct connectivity only", error);
    return {};
  }
}

function closeAuditHistory() {
  document.querySelector("#audit-dialog")?.remove();
}

async function showAuditHistory() {
  try {
    const audit = await request(`/api/sessions/${current.id}/audit`);
    const rows = audit.events.map((event) => `<li><time>${new Date(event.at).toLocaleString()}</time><strong>${escapeHtml(event.event.replaceAll("_", " "))}</strong><span>${escapeHtml(event.actor)}</span></li>`).join("");
    document.body.insertAdjacentHTML("beforeend", `<div id="audit-dialog" class="modal-backdrop" role="presentation"><section class="audit-dialog card" role="dialog" aria-modal="true" aria-labelledby="audit-title"><div class="modal-heading"><div><p class="eyebrow">SESSION RECORD</p><h2 id="audit-title">Full audit history</h2></div><button id="close-audit" class="text-button" aria-label="Close audit history">Close</button></div><ol class="audit-list">${rows || "<li>No audit events were recorded.</li>"}</ol></section></div>`);
    document.querySelector("#close-audit")?.addEventListener("click", closeAuditHistory);
    document.querySelector("#audit-dialog")?.addEventListener("click", (event) => { if (event.target.id === "audit-dialog") closeAuditHistory(); });
  } catch (error) { window.alert(error.message); }
}

async function reportSecurityConcern() {
  if (!window.confirm("This will record a security concern and end the session immediately. Continue?")) return;
  try {
    await request(`/api/sessions/${current.id}/report-abuse`, { method: "POST", body: JSON.stringify({ category: "security_concern" }) });
    clearViewer();
    stopEvents();
    saveCurrent(null);
    home();
  } catch (error) { window.alert(error.message); }
}

async function startViewer(controlGranted) {
  if (!current || current.role !== "operator") return;
  if (viewerPeer) {
    attachViewer();
    if (controlGranted) enableRemoteInput();
    return;
  }
  const iceConfig = await getIceConfiguration();
  viewerStream = new MediaStream();
  viewerPeer = new RTCPeerConnection(iceConfig);
  viewerPeer.ontrack = (event) => {
    event.streams[0]?.getTracks().forEach((track) => viewerStream.addTrack(track));
    attachViewer();
  };
  viewerPeer.onicecandidate = (event) => {
    if (event.candidate) sendSignal("candidate", event.candidate.toJSON()).catch((error) => console.warn("Could not relay ICE candidate", error));
  };
  const offer = await viewerPeer.createOffer({ offerToReceiveVideo: true });
  await viewerPeer.setLocalDescription(offer);
  await sendSignal("offer", { type: offer.type, sdp: offer.sdp });
  attachViewer();
  if (controlGranted) enableRemoteInput();
}

function queueRemoteInput(event) {
  inputQueue.push(event);
  if (inputFlushTimer) return;
  inputFlushTimer = window.setTimeout(async () => {
    inputFlushTimer = null;
    const events = inputQueue.splice(0, 64);
    if (!events.length || !current) return;
    try { await request(`/api/sessions/${current.id}/input`, { method: "POST", body: JSON.stringify({ sequence: inputSequence++, events }) }); }
    catch (error) { console.warn("Remote input was not delivered", error); }
  }, 33);
}

function enableRemoteInput() {
  if (inputAbort) return;
  const video = document.querySelector("#remote-view");
  if (!video) return;
  inputAbort = new AbortController();
  const options = { signal: inputAbort.signal };
  const position = (event) => {
    const bounds = video.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  video.addEventListener("pointermove", (event) => queueRemoteInput({ kind: "move", ...position(event) }), options);
  video.addEventListener("pointerdown", (event) => { video.focus(); const buttons = { 0: "left", 1: "middle", 2: "right" }; if (buttons[event.button]) queueRemoteInput({ kind: "button", button: buttons[event.button], down: true }); }, options);
  video.addEventListener("pointerup", (event) => { const buttons = { 0: "left", 1: "middle", 2: "right" }; if (buttons[event.button]) queueRemoteInput({ kind: "button", button: buttons[event.button], down: false }); }, options);
  video.addEventListener("contextmenu", (event) => event.preventDefault(), options);
  video.addEventListener("wheel", (event) => { event.preventDefault(); queueRemoteInput({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY }); }, { ...options, passive: false });
  window.addEventListener("keydown", (event) => { if (document.activeElement !== video || event.repeat) return; event.preventDefault(); queueRemoteInput({ kind: "key", code: event.code, down: true }); }, options);
  window.addEventListener("keyup", (event) => { if (document.activeElement !== video) return; event.preventDefault(); queueRemoteInput({ kind: "key", code: event.code, down: false }); }, options);
}

async function handleSignal(envelope) {
  if (!viewerPeer || current?.role !== "operator" || envelope.from !== "host") return;
  if (envelope.kind === "answer") await viewerPeer.setRemoteDescription(envelope.payload);
  if (envelope.kind === "candidate") await viewerPeer.addIceCandidate(envelope.payload);
}

async function subscribeToSession() {
  stopEvents();
  try {
    const grant = await request(`/api/sessions/${current.id}/event-token`, { method: "POST", body: "{}" });
    eventSource = new EventSource(`/api/sessions/${current.id}/events?access=${encodeURIComponent(grant.accessToken)}`);
    eventSource.addEventListener("session", (event) => renderSession(JSON.parse(event.data)));
    eventSource.addEventListener("signal", (event) => handleSignal(JSON.parse(event.data)).catch((error) => console.warn("Could not apply host signaling", error)));
  } catch (error) { console.warn("Live session updates are unavailable", error); }
}

async function action(actionName) { await request(`/api/sessions/${current.id}/${actionName}`, { method: "POST", body: "{}" }); sessionView(); }
async function hostAction(actionName) { await request(`/api/sessions/${current.id}/host-action`, { method: "POST", body: JSON.stringify({ action: actionName }) }); sessionView(); }
async function endSession() { await request(`/api/sessions/${current.id}/end`, { method: "POST", body: "{}" }); clearViewer(); stopEvents(); saveCurrent(null); home(); }

home();

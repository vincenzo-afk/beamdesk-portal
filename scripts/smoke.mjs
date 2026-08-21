const baseUrl = new URL(process.env.BEAMDESK_SMOKE_URL || "http://127.0.0.1:4173/");
const healthUrl = new URL("/healthz", baseUrl);

const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`BeamDesk health check failed with HTTP ${response.status}.`);

const body = await response.json();
if (body.status !== "ok" || body.service !== "beamdesk-portal") {
  throw new Error("BeamDesk health response did not contain the expected safe readiness contract.");
}
if (response.headers.get("cache-control") !== "no-store") {
  throw new Error("BeamDesk health response is missing its no-store cache protection.");
}

console.log(`BeamDesk portal is healthy at ${healthUrl.origin} (${body.relay}).`);

# BeamDesk Verification Ledger

**Audit scope:** locally executable portal, browser, Linux-host, repository, CI, dependency, and deployment-readiness checks completed on 22 August 2026, including an extended adversarial failure-path pass.

> This ledger is deliberately evidence-based. **Passing local tests do not claim that Windows desktop capture, a Wayland or X11 desktop session, multi-device WebRTC, a TURN relay, or Render production deployment has been completed.** Those require the listed external environments.

## Outcome summary

| Area | Evidence run | Result | Meaning |
|---|---|---|---|
| Portal protocol and safety | `pnpm test` | 25 passing tests | The attended session lifecycle, authorization boundaries, audit, chat, signaling, input, abuse, TURN credential routes, safe API misses, replayed event credentials, and bounded audit records passed local regression coverage. |
| Browser session UI | Local browser session: create code, join host, send chat | Passed | The UI hid chat before host join, enabled it after join, submitted a message, rendered the transcript, and produced no client-side console error. |
| Portal operational checks | Syntax checks, fresh `/healthz`, `pnpm smoke`, direct HTTP payload probe | Passed | The start path, readiness endpoint, direct-only fallback, and safe oversized-payload response were verified against a fresh local process. |
| Production JavaScript dependency audit | `pnpm audit --prod` | No known vulnerabilities reported | The installed production dependency graph had no advisory reported by the package registry at audit time. |
| Linux host unit and integration foundations | `cargo test --all-targets` | 21 passing tests | Capability selection, local approval guards, Portal/X11 input mapping, signaling conversions, and GStreamer graph construction passed. |
| Linux host quality and build | `cargo clippy --all-targets -- -D warnings`; `cargo build --release` | Passed | Strict linting and optimized compilation completed successfully. |
| Linux media prerequisites | `gst-inspect-1.0` for `webrtcbin`, `pipewiresrc`, and `ximagesrc` | Passed | The required local GStreamer element factories were discoverable. |
| Unsupported Linux environment | Release host run with invalid X11 and missing Wayland portal inputs | Passed | The current host refused capture and control with exit code 2 and did not fall back to an unsafe backend. |
| Repository integrity | `git fsck --no-reflogs --unreachable` | Passed after cleanup | The only stale, unreachable automation-authored local object was removed; no unreachable objects remain. |

## Feature evidence

| Feature boundary | Automated or direct evidence | Result |
|---|---|---|
| One-time code and ten-minute session lifecycle | Portal flow tests cover creation, host join, expiry, end, terminal purge, and post-terminal rejection. | Passed locally. |
| Separate viewing and control approvals | Portal state-machine tests and Linux local-permission tests require view before control. | Passed locally. |
| Role-scoped credentials and SSE | Tests cover event-token authentication, one-time use, issue limits, terminal invalidation, and heartbeat cleanup. | Passed locally. |
| WebRTC signaling | Tests cover role checks, consent gating, accepted opaque offers/answers/candidates, and per-role signaling limits. | Passed locally. |
| Remote input | Tests cover operator-only access, control-state gating, canonical events, replay rejection, and rate limits. | Passed locally. |
| Session chat | Tests cover host-join gating, participant authorization, normalization, live SSE delivery, size/rate/transcript limits, terminal retention, and purge. A browser session also submitted and rendered a message. | Passed locally. |
| Audit and abuse response | Tests cover authenticated terminal audit access, bounded retention, abuse reporting, and session termination. | Passed locally. |
| HTTP hardening | Tests and direct probes cover security headers, cache prevention, malformed JSON, payload-size rejection, request/session limits, and health response secrecy. | Passed locally. |
| API error boundary | Adversarial tests cover unknown API routes and invalid TURN HMAC configuration. | Passed locally with safe JSON 404 and direct-only 503 behavior. |
| TURN credential boundary | Tests cover pre-view denial, short-lived configured credentials, terminal rejection, and absent-secret failure. | Passed locally; no relay was provisioned. |
| Linux attended policy | Tests cover Wayland portal refusal without a portal, X11 selection rules, local approval guards, and static media graphs. | Passed locally; no compositor was available. |
| Windows attended policy | Source contains a fail-closed WPF compatibility preflight only. | **Not validated:** no Windows folder or .NET desktop environment is currently connected. |

## Defects found and corrected

| Finding | Correction | Regression evidence |
|---|---|---|
| A JSON body over the 16 KiB limit returned a generic HTTP 500 response. | The error handler now returns cache-safe JSON with HTTP 413 and no framework details. | `oversized JSON requests receive a safe 413 response instead of an internal error`. |
| Strict Linux linting rejected `LocalApprovalState::new` without `Default`. | Added the equivalent `Default` implementation. | `cargo clippy --all-targets -- -D warnings`. |
| Strict Linux linting flagged an oversized `ActiveInput` enum variant. | Boxed the X11 controller variant without changing the attended control flow. | `cargo clippy --all-targets -- -D warnings` and all Linux tests. |
| CI did not check browser JavaScript syntax, strict Rust linting, or a release build. | CI now runs both JavaScript syntax checks, strict Rust linting, and a release compile; actions were updated to their Node 24-compatible major releases. | Local equivalents passed. A post-push workflow dispatch was attempted and GitHub returned HTTP 422 because Actions is disabled for the repository owner. |
| Render instructions referred to a private repository and did not state the single-process state constraint. | Documentation now uses repository-neutral access wording and records that the current in-memory portal must remain single-instance. | Documentation review. |
| Unknown `/api/*` routes fell through to Express’ HTML 404 page. | Added a scoped JSON API fallback that preserves the portal security headers. | `unknown API routes return a safe JSON response with portal security headers`. |
| An invalid TURN HMAC algorithm threw an unhandled exception and reported a configured relay in health checks. | TURN capability now validates HMAC construction first and fails closed to the existing direct-only 503 path. | `invalid TURN HMAC configuration fails closed without producing a server error`. |
| Repeated TURN credential reads could retain 257 audit entries rather than the stated bound. | Centralized audit insertion now trims every session record to 256 entries. | `repeated TURN reads cannot grow a session audit record beyond its retained bound`. |
| Browser session actions could surface rejected requests as unhandled promise errors. | Centralized action error handling now renders an in-session alert and viewer startup cleans up partial media state before reporting a failure. | Browser source syntax checks, static accessibility inspection, and served-session interaction checks passed. |
| The Linux host safely refused unavailable local-display paths but returned exit code 0. | Startup and view-approval failures now exit with code 2 so scripts and supervisors can identify a refused host run. | Release binary checks for invalid X11 and missing Wayland portal both returned code 2. |

## Required real-environment validation

The following items are not defects in the local test results; they are **environmental acceptance gates** and must remain explicitly unclaimed until performed.

| Required environment | Required verification |
|---|---|
| Connected Windows 10/11 development folder | Build the WPF host, run its compatibility preflight, then implement and test actual Windows Graphics Capture and separately approved input injection. |
| GNOME or KDE Wayland session | Confirm compositor-owned ScreenCast and RemoteDesktop dialogs, picker cancellation, approval, revoke, expiry teardown, and encrypted media. |
| Logged-in Xorg session with XTEST | Confirm inherited-display validation, capture, canonical input injection, revoke behavior, and pressed-key/button cleanup. |
| Two real devices and a public portal | Exercise complete offer/answer/ICE exchange, view/control approval, input delivery, chat, disconnect recovery, and terminal teardown. |
| Persistent CoTURN host | Validate authenticated relay credentials and relay-only WebRTC over the planned UDP/TCP/TLS endpoints. |
| Render account connected to the repository | Deploy the Blueprint, set protected TURN variables only after CoTURN validation, and run `pnpm smoke` against the deployment. |
| GitHub Actions run on `master` | Confirm the updated portal and Linux CI jobs complete successfully before enabling required status checks or branch protection. |

## Reproduction commands

```bash
# Portal regression and syntax checks
pnpm test
node --check server.mjs
node --check public/app.js
pnpm audit --prod

# Start and smoke-test a local portal
pnpm start
BEAMDESK_SMOKE_URL="http://127.0.0.1:4173/" pnpm smoke

# Linux host foundation
cd linux-host-agent
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo build --release
```

## References

[1]: [Portal regression suite](test/session-flow.test.mjs)
[2]: [Linux host tests and implementation](linux-host-agent/)
[3]: [Cross-platform acceptance matrix](acceptance-matrix.md)
[4]: [Render deployment notes](render-deployment-notes.md)

# BeamDesk Linux Host Agent — Features 3–4

This agent adds Linux to the same attended-support model used for Windows. It joins a BeamDesk support session only after a local user enters a code, keeps screen viewing and remote control as distinct approvals, and revokes control back to view-only immediately.

## Supported design paths

| Linux session type | Planned capture and input path | Product boundary |
|---|---|---|
| Wayland with XDG Desktop Portal | `ScreenCast`, PipeWire stream, GStreamer `webrtcbin`, and `RemoteDesktop` keyboard/pointer portal calls | Preferred. The compositor presents distinct display and control approval dialogs. |
| Wayland without an available portal | Unsupported | The agent refuses the session; it does not bypass compositor consent. |
| Interactive X11 | Compatibility backend to be added later | Requires explicit local permission and an attended desktop session. |
| Headless/secure desktop | Unsupported in v1 | No unattended or lock-screen access. |

The XDG Remote Desktop portal explicitly supports a user dialog after `Start()`, separate selection of keyboard/pointer/touchscreen device types, and integration with ScreenCast/PipeWire. It recommends EIS for input events. [1] The ScreenCast portal returns a PipeWire remote FD after the user starts a selected capture session. [2] On X11, any virtual input backend will be constrained to the active user session. Linux’s `uinput` device allows userspace to emulate input devices and is therefore deliberately not used until a separately approved, capability-limited implementation is tested. [3]

## Local development

The core permission state machine has no desktop dependency and can be tested with:

```bash
cargo test
```

## Feature 4–5 Wayland capture and separate control development path

The current runtime is intentionally **Wayland-only** and uses `xdg-desktop-portal`, PipeWire, GStreamer, and the RemoteDesktop portal. A person at the host computer must type `SHARE`, then complete the compositor-owned source picker. When an operator later requests control, the host must separately type `CONTROL` and complete the desktop environment’s keyboard/pointer permission dialog. The implementation does not use `uinput`, raw XTest calls, or a background input device.

Provide only the host credential returned by the attended join flow; it is role-scoped and expires with the session:

```bash
export BEAMDESK_PORTAL_AVAILABLE=1
export BEAMDESK_PORTAL_URL="https://your-beamdesk-portal.example/"
export BEAMDESK_SESSION_ID="session-id-from-join"
export BEAMDESK_SESSION_TOKEN="host-token-from-join"
cargo run
```

For local portal development, `http://127.0.0.1:4173/` is accepted. Every other portal URL must use HTTPS. The operator must send a view request first; only after the local terminal confirmation and desktop portal selection does the agent mirror an `approve-view` action and accept WebRTC offer/candidate envelopes.

The control path accepts only the portal’s canonical `move`, `button`, `key`, and `wheel` envelopes. It rejects unknown key/button names, deduplicates stale input batches, bounds pointer/scroll deltas, and drops the live RemoteDesktop session on revoke, expiry, end, or process exit. The capture and input paths must still be tested on actual GNOME/KDE Wayland sessions; this headless sandbox cannot validate a compositor’s picker, PipeWire stream, or display/input injection.

## References

[1]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html
[2]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html
[3]: https://docs.kernel.org/input/uinput.html

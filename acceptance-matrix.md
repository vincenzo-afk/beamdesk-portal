# BeamDesk Acceptance Matrix

BeamDesk is an **attended-only** product. This matrix differentiates automated verification from real-device checks that cannot be truthfully completed from a headless Linux build environment.

| Capability | Automated evidence | Current status | Required real-device acceptance check |
|---|---|---|---|
| One-time support-code lifecycle | Portal regression suite: creation, join, expiry, terminal cleanup | Passing | Create and join a disposable session from two separate browsers. |
| Separate view and control approval | Portal and Linux permission-state tests | Passing | Host approves view, denies control, then approves control on a real desktop. |
| Browser signaling/input boundary | Portal tests: consent gate, role checks, canonical input validation, terminal rejection | Passing | Validate an offer/answer/ICE exchange between two real devices. |
| Audit and report-and-end | Portal tests: protected terminal audit and abuse-report termination | Passing | Verify audit visibility for both session roles after an intentional end. |
| Abuse and network limits | Portal tests: active-session cap and retry metadata | Passing | Confirm trusted-proxy configuration with the production hosting provider. |
| TURN credential issue path | Portal and Linux tests: consent gate, expiry bound, missing-secret failure | Passing, relay not yet deployed | Install CoTURN, configure the protected shared secret, and force relay-only connectivity. |
| Linux Wayland view/control | Rust tests: portal approval gates and PipeWire/WebRTC graph construction | Build verified | Test GNOME and KDE Wayland compositor dialogs, PipeWire stream, and RemoteDesktop/EIS control. |
| Linux X11 view/control | Rust tests: capability selection, inaccessible-display failure, X11 media graph, strict XTEST mapping | Build verified | Run inside a logged-in Xorg session with the inherited `DISPLAY` and validate view, control revoke, and pressed-key cleanup. |
| Windows 10/11 view/control | WPF host source scaffold and compatibility contract | Pending Windows environment | Build and test Windows Graphics Capture plus attended `SendInput` on Windows 10 version 1903+ and Windows 11. |

## Current test commands

```bash
cd /home/ubuntu/remote-support-portal && pnpm test
cd /home/ubuntu/remote-support-portal/linux-host-agent && cargo test
# In a second terminal after starting the portal, or against a deployed URL:
cd /home/ubuntu/remote-support-portal && BEAMDESK_SMOKE_URL="https://your-beamdesk-portal.example/" pnpm smoke
```

The current automated suite intentionally exercises protocol, authorization, lifecycle, and native graph construction. It does not represent a claim of end-to-end remote desktop access until the indicated Wayland, X11, Windows, and TURN tests are run on real devices.

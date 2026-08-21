# BeamDesk Desktop Compatibility Matrix

BeamDesk is designed for **attended support**, not silent device administration. “Windows and Linux support” means that the host agent must select an operating-system-native, user-visible approval mechanism for the active desktop session. If that mechanism is unavailable, BeamDesk must show an unsupported-environment message and must not substitute background capture or input injection.

## Intended support envelope

| Host environment | View path | Control path | Required local approval | Current implementation state |
|---|---|---|---|---|
| Windows 10/11 desktop | Windows Graphics Capture after `GraphicsCaptureSession.IsSupported()` and the system picker | `SendInput` only after the separate control approval | BeamDesk view prompt, Windows picker, then a distinct BeamDesk control prompt | WPF approval shell exists; capture and input adapter require a Windows build machine |
| Linux Wayland with a ScreenCast and RemoteDesktop portal | XDG ScreenCast portal → PipeWire → GStreamer WebRTC | XDG RemoteDesktop portal device grant | Terminal/app confirmation, compositor source picker, then compositor keyboard/pointer dialog | Native Rust capture, signaling, and portal input foundation implemented; requires a real supported desktop session for validation |
| Linux X11 with capture and XTEST extensions | GStreamer `ximagesrc` → GStreamer WebRTC | XTEST input synthesis | Visible BeamDesk host prompt for view and a separate control prompt | Planned adapter; it must verify the active X display and extensions before enabling either capability |
| Headless Linux, unsupported compositor, missing portal/backend, or missing X11 extensions | None | None | Not applicable | Must fail closed with an actionable compatibility message |

## Windows policy

Microsoft’s capture API exposes `GraphicsCaptureSession.IsSupported()` specifically so an application can detect whether the current device can capture; it also requires a system picker that lets the user select a display or window and shows a system capture border while capture is active. [1] BeamDesk will use these mechanisms rather than an invisible desktop-duplication fallback. Each candidate Windows host will therefore be tested at runtime for supported capture, an interactive desktop, and a user-completed item selection.

The approved control adapter will map the portal’s canonical keyboard and pointer events to `SendInput`, which serially inserts events into the Windows input stream. [2] BeamDesk will not run as a service for the attended path, will not attempt to cross the secure desktop boundary, and will not attempt to automate UAC, the lock screen, credential UI, or another higher-integrity desktop.

## Linux policy

On Wayland, the XDG RemoteDesktop portal creates a desktop-control session, lets the requester select device types, and presents a user dialog during `Start()`. It can share that approved session with ScreenCast so that video and input are governed by the same desktop-environment authority. [3] BeamDesk requests non-persistent permissions only. Its Wayland host has separate screen-view and control activation states and tears the portal session down when the local person revokes or ends support.

On X11, BeamDesk will use GStreamer’s `ximagesrc` only after verifying an accessible user `DISPLAY`; the element captures an X display and can take advantage of XDamage and XFixes for changed regions and cursor handling. [4] It will use XTEST only when the extension is present, after the local control prompt, and only for the already validated canonical event types. X11 support does not imply Wayland support and is never a reason to bypass a Wayland compositor’s portal.

## Runtime compatibility checks

| Check | Safe behavior on failure |
|---|---|
| No interactive user desktop or no approved local view action | Do not create a capture source, stream, or TURN configuration request. |
| Windows `IsSupported()` is false or picker is cancelled | Keep the session pending and explain that this Windows device cannot provide attended capture through BeamDesk. |
| Wayland portal lacks ScreenCast or RemoteDesktop support, or the user cancels either dialog | End the requested capability and retain no capture/input fallback. |
| X11 `DISPLAY`, XDamage/XFixes, or XTEST capability check fails | Refuse the affected capability and state which extension is missing. |
| Session expires, is revoked, or the process ends | Stop WebRTC, close PipeWire/X11/Windows capture resources, release pressed keys/buttons, and terminate portal input access. |

## Validation required before release

The current sandbox can compile the Linux host modules but cannot act as a GNOME/KDE compositor or a Windows interactive desktop. Release verification must therefore run the following real-device matrix:

| Platform | Minimum scenarios |
|---|---|
| Windows 10/11 | Picker cancel, one-monitor view, multi-monitor view, view revoke, control deny/allow/revoke, lock/UAC refusal, and network relay fallback. |
| GNOME Wayland | Portal view allow/cancel, RemoteDesktop device allow/cancel, PipeWire video, key/pointer/button/wheel delivery, revoke, and compositor restart. |
| KDE Plasma Wayland | The same Wayland cases using the KDE portal backend. |
| Linux X11 | Extension discovery, one/multi-monitor capture, visible host prompts, control boundary, XTEST injection, and host-session teardown. |

## References

[1]: https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture "Microsoft: Screen capture"
[2]: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput "Microsoft: SendInput function"
[3]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html "XDG Desktop Portal: RemoteDesktop"
[4]: https://gstreamer.freedesktop.org/documentation/ximagesrc/index.html "GStreamer: ximagesrc"

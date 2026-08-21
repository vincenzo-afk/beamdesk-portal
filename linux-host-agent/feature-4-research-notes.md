# BeamDesk Linux Feature 4 — Implementation Notes

The Wayland path must create an XDG ScreenCast session, call `SelectSources`, and call `Start`; the portal normally presents the source-picker dialog during the start request. The approved stream is then exposed to the client as a PipeWire stream. BeamDesk uses `PersistMode::DoNot`, so the portal approval never becomes an unattended or remembered capture permission. [1]

PipeWire portal clients receive a restricted file descriptor rather than unrestricted graph access. The PipeWire connection and selected node must remain owned by the host process for the entire media session. [2]

The Rust `ashpd` binding provides the required `Screencast::create_session`, `select_sources`, `start`, and `open_pipe_wire_remote` APIs, including an example that hands the portal-owned PipeWire descriptor to GStreamer. [3]

GStreamer’s Rust WebRTC bindings provide `webrtcbin` APIs for SDP/ICE negotiation. BeamDesk will accept the browser operator's offer only after portal approval, generate a native answer, and return opaque answer/candidate envelopes through the existing consent-gated portal relay. [4]

## References

[1]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.ScreenCast.html "XDG Desktop Portal ScreenCast interface"
[2]: https://docs.pipewire.org/page_portal.html "PipeWire Portal Access Control"
[3]: https://docs.rs/ashpd/latest/ashpd/desktop/screencast/index.html "ashpd ScreenCast API"
[4]: https://gstreamer.freedesktop.org/documentation/rust/stable/latest/docs/gstreamer_webrtc/ "GStreamer WebRTC Rust bindings"

# Feature 6 research notes — authenticated ICE configuration

CoTURN documents secret-based timed authentication for its TURN REST API. BeamDesk should retain that shared secret only on its portal server, generate a temporary username containing the expiry, and derive the temporary password with the configured HMAC algorithm. The endpoint must return those credentials only to an authenticated, unexpired session participant; it must never return the underlying shared secret. [1]

GStreamer `webrtcbin` supports browser-style WebRTC negotiation and exposes an `add-turn-server` action signal to add a TURN server URI for ICE candidate gathering. The native Linux host can therefore receive the same short-lived credential from the authenticated BeamDesk portal and configure its WebRTC sender before negotiating the SDP answer. [2]

## References

[1]: https://github.com/coturn/coturn/blob/master/README.turnserver
[2]: https://gstreamer.freedesktop.org/documentation/webrtc/

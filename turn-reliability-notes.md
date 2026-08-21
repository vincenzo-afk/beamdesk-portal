# TURN Relay Reliability Contract

Direct WebRTC connectivity is often impossible across NATs and restrictive firewalls, so a production BeamDesk session needs a TURN relay. The WebRTC project explicitly identifies TURN as the usual relay mechanism when peer-to-peer sockets cannot be formed and notes that the `RTCConfiguration` needs a TURN URL plus username and credential. [1]

CoTURN is a maintained open-source TURN/STUN implementation. Its documentation describes `turnserver` as the relay binary and supports authenticated operation, including secret-based timed authentication for the TURN REST API. Its example configuration documents standard TURN listener port `3478`, TLS listener port `5349`, relay-address considerations, public/private `external-ip` mapping for NATed instances, and a default TLS minimum of 1.2. [2][3]

## BeamDesk production contract

1. Run CoTURN on a persistent Linux host with a public IP and direct UDP/TCP reachability; a typical web-only serverless deployment is unsuitable because TURN needs long-lived sockets and UDP relay-port ranges.
2. Configure a dedicated realm, long-term credentials with TURN REST shared-secret authentication, `fingerprint`, TLS certificate/key, and a bounded relay port range. Do not use anonymous `no-auth` mode.
3. Mint one expiring TURN username/credential pair per approved support session. The credential lifetime must be no longer than the session expiry and be invalidated when the host ends or revokes the session.
4. Return TURN credentials to the browser and signed host agent only after the host has approved screen view. Use the same ephemeral relay credentials for the subsequently approved control session; no credential should be displayed in the operator UI or persisted in analytics.
5. Restrict firewall access to TURN/STUN listener ports and the selected UDP relay range. Configure public/private `external-ip` mapping precisely if the relay runs behind NAT.
6. Monitor allocation count, bandwidth, authentication failures, and relay saturation. Rate-limit session creation and terminate allocation access with the support session.

## Example WebRTC configuration shape

```js
const peer = new RTCPeerConnection({
  iceServers: [{
    urls: ["turns:turn.example.com:5349?transport=tcp", "turn:turn.example.com:3478?transport=udp"],
    username: shortLivedUsername,
    credential: shortLivedCredential,
  }],
});
```

## Portal credential endpoint

The BeamDesk portal now exposes `GET /api/sessions/:id/ice-config`. It requires the role-scoped `x-session-token`, rejects sessions before `VIEW_ACTIVE`, generates a CoTURN REST credential that expires in at most five minutes (and never after the support session), and records an audit event without exposing the shared secret. The browser consumes its `iceServers` response directly; the Linux native host converts the returned values to GStreamer `webrtcbin` TURN URIs.

Set these server-only environment variables before enabling the endpoint in production:

| Variable | Purpose |
|---|---|
| `BEAMDESK_TURN_URLS` | Comma-separated standard WebRTC TURN URIs, for example `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`. |
| `BEAMDESK_TURN_SHARED_SECRET` | CoTURN REST shared secret. Never publish it to a browser, native client, source repository, log, or audit record. |
| `BEAMDESK_TURN_HMAC_ALGORITHM` | Optional HMAC algorithm used by both CoTURN and the portal; defaults to `sha1` for CoTURN REST compatibility. |

This is a deployment contract and not a claim that the local prototype currently operates a relay. Running CoTURN requires a persistent, network-capable Linux environment and a production secret-management path. It must be set up only when that host and its protected credentials are available.

## Sources

[1]: https://webrtc.org/getting-started/turn-server
[2]: https://github.com/coturn/coturn/blob/master/README.turnserver
[3]: https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf

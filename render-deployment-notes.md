# BeamDesk Render Deployment Notes

The repository now includes a root `render.yaml` Blueprint for the **BeamDesk portal only**. It uses `pnpm install --frozen-lockfile`, starts the Express service with `pnpm start`, probes `/healthz`, and enables trusted proxy handling only in the Render deployment. The portal continues to work in direct WebRTC mode until a TURN URL and shared secret are configured.

Render Blueprints are repository-root YAML definitions that Render deploys after a user connects the Git repository in the Render Dashboard. Sensitive environment variables should be declared with `sync: false`, which prompts for their value in Render rather than putting it in the repository. [1] [2]

| Variable | Blueprint behavior | Production requirement |
|---|---|---|
| `BEAMDESK_TRUST_PROXY` | Set to `true` for the Render web service. | Keep this setting limited to deployments behind Render’s proxy. Do not enable it for a directly exposed local server. |
| `BEAMDESK_TURN_URLS` | `sync: false`. | Enter the standard TURN/TURNS URLs supplied by a separately operated CoTURN relay. |
| `BEAMDESK_TURN_SHARED_SECRET` | `sync: false`. | Enter the CoTURN REST shared secret only in Render’s protected environment-variable UI. |
| `BEAMDESK_TURN_HMAC_ALGORITHM` | Defaults to `sha1`. | Match the CoTURN REST credential configuration. |

The Blueprint does **not** provision CoTURN. A TURN relay needs a persistent, network-capable host that supports its UDP/TCP relay ports; it must be deployed and tested separately before BeamDesk can claim relay-backed connectivity. The portal’s authenticated credential endpoint already fails closed when those variables are absent.

## Manual deployment sequence

1. In Render, connect the GitHub account that can access the private `vincenzo-afk/beamdesk-portal` repository.
2. Select **New → Blueprint**, choose the repository and its `master` branch, then review the `beamdesk-portal` web-service definition.
3. Enter the TURN variables only if a separately tested CoTURN relay is available. Otherwise leave them unset and use direct-only development connectivity.
4. Deploy the Blueprint and run `BEAMDESK_SMOKE_URL="https://<render-service>.onrender.com/" pnpm smoke` from a trusted machine.

## References

[1]: https://render.com/docs/blueprint-spec
[2]: https://render.com/docs/infrastructure-as-code

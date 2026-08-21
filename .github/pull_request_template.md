## Intent

Describe the user-facing and technical change.

## Attended-support boundary

- [ ] This does not add unattended access, background capture, or secure-desktop/UAC bypass behavior.
- [ ] View and control approvals remain separate, and revocation behavior is preserved.

## Verification

- [ ] `pnpm test`
- [ ] `cargo test` in `linux-host-agent` when native host code changed
- [ ] `pnpm smoke` against a running portal when portal deployment behavior changed
- [ ] Relevant real-device checks are described if this change affects Windows, Wayland, X11, or TURN.

## Documentation and compatibility

- [ ] Documentation, compatibility notes, and configuration instructions are updated where needed.
- [ ] No secrets, support-session tokens, recordings, or personal data are included.

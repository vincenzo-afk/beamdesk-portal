# Contributing to BeamDesk

BeamDesk handles attended remote-support sessions, so every contribution must preserve the core boundary: a local person must approve viewing and must separately approve control. Changes must not introduce unattended access, background capture, secure-desktop/UAC bypasses, or silent input injection.

## Development setup

Use Node.js 22 with pnpm for the portal and a current Rust toolchain for the Linux host. The verified commands are:

```bash
cd /path/to/beamdesk-portal
pnpm install --frozen-lockfile
pnpm test

cd linux-host-agent
cargo test
```

To run the portal locally, use `pnpm dev`. To test its public readiness contract after the portal is running, use `pnpm smoke` or set `BEAMDESK_SMOKE_URL` to the deployment URL.

## Contribution workflow

Create a focused branch using a descriptive prefix such as `feat/`, `fix/`, `docs/`, or `test/`. Keep commits narrowly scoped and use an imperative summary. Before opening a pull request, run the relevant commands above and update the root documentation or the affected host-agent documentation when behavior, configuration, or support boundaries change.

Pull requests should explain the intended behavior, identify the approval and revocation implications, list the tests run, and state whether a Windows, Wayland, X11, or TURN real-device check is still needed. Do not describe a headless build as proof of an interactive desktop integration.

## Scope and safety requirements

Only the canonical event types implemented by the portal are accepted for remote control: pointer movement, supported mouse buttons, supported keyboard codes, and bounded scroll deltas. Any new event type, transport capability, or host-platform backend requires explicit validation, local consent review, regression tests, and a documented failure mode.

The repository currently has no published private vulnerability-reporting address. Do not include secrets, access tokens, session credentials, TURN shared secrets, recordings, or personally identifying support-session data in commits, issues, screenshots, or pull requests.

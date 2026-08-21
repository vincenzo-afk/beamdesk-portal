# BeamDesk Windows Host Agent — Feature 3

This WPF project is the **attended-support host shell**. It joins the public support-code portal, polls for role-scoped session state, and presents separate local approval controls for screen viewing and keyboard/mouse control. It contains **no screen capture or input injection implementation yet**; those are later, separately tested features.

## Security behavior

The user at the Windows PC enters the support code locally. Joining does not share content. A view request activates a local screen-sharing approval panel; a control request activates a separate local remote-control panel. The host can deny either request and can end the session locally. The code deliberately has no unattended startup, background service, UAC/secure-desktop handling, or persisted credentials.

## Build on Windows

Install the .NET 8 SDK on Windows, then run:

```powershell
$env:BEAMDESK_PORTAL_URL = "https://your-portal.example/"
dotnet build .\BeamDesk.HostAgent\BeamDesk.HostAgent.csproj
dotnet run --project .\BeamDesk.HostAgent\BeamDesk.HostAgent.csproj
```

The agent must be code-signed before public distribution. The current Linux development environment cannot compile or run a Windows WPF executable, so final host-agent validation must happen on a Windows development machine or attached Windows workspace.

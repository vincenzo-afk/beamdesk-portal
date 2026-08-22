namespace BeamDesk.HostAgent;

/// <summary>
/// Deliberately conservative preflight for the attended Windows host. A future
/// native adapter must pass its own GraphicsCaptureSession support check before
/// returning <c>true</c> for capture availability.
/// </summary>
public sealed record WindowsHostCompatibility(
    bool CanJoinSupport,
    bool CanStartView,
    bool CanStartControl,
    string Detail)
{
    public static WindowsHostCompatibility Evaluate(
        bool isWindows,
        bool isInteractive,
        Version osVersion,
        bool nativeCaptureAdapterAvailable,
        bool nativeInputAdapterAvailable)
    {
        if (!isWindows)
            return new(false, false, false, "BeamDesk Windows Host must run on Windows.");
        if (!isInteractive)
            return new(false, false, false, "BeamDesk refuses non-interactive desktops and Windows services.");
        if (osVersion.Major < 10)
            return new(false, false, false, "BeamDesk requires Windows 10 or Windows 11 for its attended capture path.");
        if (!nativeCaptureAdapterAvailable)
            return new(true, false, false, "This Windows build does not yet contain the attended Windows Graphics Capture adapter, so view and control requests are refused safely.");
        if (!nativeInputAdapterAvailable)
            return new(true, true, false, "Screen viewing can be started after the system picker, but this build does not contain the separately approved Windows input adapter.");
        return new(true, true, true, "This interactive Windows desktop is eligible for attended BeamDesk support. The system capture picker must still approve the selected display.");
    }
}

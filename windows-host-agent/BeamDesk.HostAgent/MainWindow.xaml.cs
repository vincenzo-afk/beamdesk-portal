using System.Windows;
using System.Windows.Threading;

namespace BeamDesk.HostAgent;

public partial class MainWindow : Window
{
    private readonly PortalClient _portal = new(new Uri(Environment.GetEnvironmentVariable("BEAMDESK_PORTAL_URL") ?? "https://your-beamdesk-portal.example/"));
    private readonly DispatcherTimer _pollTimer = new() { Interval = TimeSpan.FromSeconds(2) };
    private JoinedSession? _session;
    private bool _viewPromptShown;
    private bool _controlPromptShown;
    private readonly WindowsHostCompatibility _compatibility;

    public MainWindow()
    {
        InitializeComponent();
        _compatibility = WindowsHostCompatibility.Evaluate(
            OperatingSystem.IsWindows(),
            Environment.UserInteractive,
            Environment.OSVersion.Version,
            nativeCaptureAdapterAvailable: false,
            nativeInputAdapterAvailable: false);
        _pollTimer.Tick += async (_, _) => await RefreshAsync();
        EndButton.IsEnabled = false;
        if (!_compatibility.CanJoinSupport)
        {
            JoinButton.IsEnabled = false;
            CodeInput.IsEnabled = false;
            SetStatus("Windows host unavailable", _compatibility.Detail);
        }
    }

    private async void JoinButton_Click(object sender, RoutedEventArgs e)
    {
        var code = CodeInput.Text.Trim();
        if (string.IsNullOrWhiteSpace(code)) { SetStatus("Enter a support code", "Ask the support person for the temporary code before joining."); return; }
        try
        {
            JoinButton.IsEnabled = false;
            _session = await _portal.JoinAsync(code);
            EndButton.IsEnabled = true;
            CodeInput.IsEnabled = false;
            SetStatus("Connected to support session", "Waiting for a request from the operator. Nothing is shared yet.");
            _pollTimer.Start();
            await RefreshAsync();
        }
        catch (Exception ex)
        {
            SetStatus("Could not join", ex.Message);
            JoinButton.IsEnabled = true;
        }
    }

    private async Task RefreshAsync()
    {
        if (_session is null) return;
        try
        {
            var state = await _portal.GetSessionAsync(_session);
            ApplyState(state);
        }
        catch (PortalRequestException ex) when (ex.StatusCode is 404 or 410)
        {
            ResetSessionUi("Session unavailable", "The attended support session ended or expired. No sharing or remote control is active.");
        }
        catch (Exception ex) { SetStatus("Connection status unavailable", ex.Message); }
    }

    private void ApplyState(SessionStatus session)
    {
        ViewPrompt.Visibility = session.State == "VIEW_PENDING" ? Visibility.Visible : Visibility.Collapsed;
        ControlPrompt.Visibility = session.State == "CONTROL_PENDING" ? Visibility.Visible : Visibility.Collapsed;
        PauseButton.Visibility = session.State == "CONTROL_ACTIVE" ? Visibility.Visible : Visibility.Collapsed;
        ActiveBanner.Visibility = session.State is "VIEW_ACTIVE" or "CONTROL_ACTIVE" ? Visibility.Visible : Visibility.Collapsed;
        ActiveBannerText.Text = session.State == "CONTROL_ACTIVE" ? "REMOTE CONTROL ACTIVE — Pause or end this session whenever you want." : "SCREEN SHARING ACTIVE — Remote control remains disabled.";
        SetStatus(session.State.Replace('_', ' '), session.State switch
        {
            "VIEW_PENDING" => "The operator asked to view your screen. Decide locally before anything is shared.",
            "CONTROL_PENDING" => "The operator asked for remote control. You can keep the session view-only.",
            "CONTROL_ACTIVE" => "Input will only be accepted while this window shows remote control active.",
            _ => "Your local consent determines what the operator can do."
        });
        if (session.State == "VIEW_PENDING" && !_viewPromptShown) { _viewPromptShown = true; Activate(); Topmost = true; }
        if (session.State == "CONTROL_PENDING" && !_controlPromptShown) { _controlPromptShown = true; Activate(); Topmost = true; }
        if (session.State is not "VIEW_PENDING" and not "CONTROL_PENDING")
        {
            _viewPromptShown = false;
            _controlPromptShown = false;
            Topmost = false;
        }
    }

    private async void ApproveView_Click(object sender, RoutedEventArgs e) => await HostActionAsync("approve-view");
    private async void DenyView_Click(object sender, RoutedEventArgs e) => await HostActionAsync("deny-view");
    private async void ApproveControl_Click(object sender, RoutedEventArgs e) => await HostActionAsync("approve-control");
    private async void DenyControl_Click(object sender, RoutedEventArgs e) => await HostActionAsync("deny-control");
    private async void PauseButton_Click(object sender, RoutedEventArgs e) => await HostActionAsync("revoke-control");

    private async Task HostActionAsync(string action)
    {
        if (_session is null) return;
        if (action == "approve-view" && !_compatibility.CanStartView)
        {
            SetStatus("Screen viewing unavailable", _compatibility.Detail);
            return;
        }
        if (action == "approve-control" && !_compatibility.CanStartControl)
        {
            SetStatus("Remote control unavailable", _compatibility.Detail);
            return;
        }
        try { ApplyState(await _portal.HostActionAsync(_session, action)); }
        catch (Exception ex) { SetStatus("Action could not be completed", ex.Message); }
    }

    private async void EndButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_session is not null) await _portal.EndAsync(_session);
            ResetSessionUi("Session ended", "No screen sharing or remote control is active.");
        }
        catch (Exception ex)
        {
            ResetSessionUi("Local session closed", $"Local sharing was stopped. The portal could not confirm the end request: {ex.Message}");
        }
    }

    private void ResetSessionUi(string title, string detail)
    {
        _pollTimer.Stop();
        _session = null;
        _viewPromptShown = false;
        _controlPromptShown = false;
        Topmost = false;
        CodeInput.IsEnabled = _compatibility.CanJoinSupport;
        CodeInput.Text = "";
        JoinButton.IsEnabled = _compatibility.CanJoinSupport;
        EndButton.IsEnabled = false;
        ViewPrompt.Visibility = ControlPrompt.Visibility = ActiveBanner.Visibility = PauseButton.Visibility = Visibility.Collapsed;
        SetStatus(title, detail);
    }

    private void SetStatus(string title, string detail) { StatusTitle.Text = title; StatusDetail.Text = detail; }
}

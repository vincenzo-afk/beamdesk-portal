using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace BeamDesk.HostAgent;

public sealed class PortalClient
{
    private readonly HttpClient _http;
    public PortalClient(Uri baseAddress) => _http = new HttpClient { BaseAddress = baseAddress };

    public async Task<JoinedSession> JoinAsync(string code)
    {
        using var response = await _http.PostAsJsonAsync("api/sessions/join", new { code, agentNonce = Guid.NewGuid().ToString("N") });
        await EnsureSuccess(response);
        var result = await response.Content.ReadFromJsonAsync<JoinResponse>() ?? throw new InvalidOperationException("Invalid portal response.");
        return new JoinedSession(result.SessionId, result.Token);
    }

    public Task<SessionStatus> GetSessionAsync(JoinedSession session) => SendForStatusAsync(HttpMethod.Get, $"api/sessions/{session.SessionId}", session.Token);
    public Task<SessionStatus> HostActionAsync(JoinedSession session, string action) => SendForStatusAsync(HttpMethod.Post, $"api/sessions/{session.SessionId}/host-action", session.Token, new { action });

    public async Task EndAsync(JoinedSession session)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"api/sessions/{session.SessionId}/end") { Content = JsonContent.Create(new { }) };
        request.Headers.Add("x-session-token", session.Token);
        using var response = await _http.SendAsync(request);
        await EnsureSuccess(response);
    }

    private async Task<SessionStatus> SendForStatusAsync(HttpMethod method, string path, string token, object? payload = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Add("x-session-token", token);
        if (payload is not null) request.Content = JsonContent.Create(payload);
        using var response = await _http.SendAsync(request);
        await EnsureSuccess(response);
        return await response.Content.ReadFromJsonAsync<SessionStatus>() ?? throw new InvalidOperationException("Invalid portal response.");
    }

    private static async Task EnsureSuccess(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return;
        var error = await response.Content.ReadFromJsonAsync<ErrorResponse>();
        throw new InvalidOperationException(error?.Error ?? $"Portal request failed ({(int)response.StatusCode}).");
    }

    private sealed record JoinResponse(string SessionId, string Token);
    private sealed record ErrorResponse(string Error);
}

public sealed record JoinedSession(string SessionId, string Token);
public sealed record SessionStatus(string State, DateTimeOffset ExpiresAt);

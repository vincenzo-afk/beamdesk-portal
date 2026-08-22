//! Minimal client for the existing BeamDesk session and SSE signaling contract.

use std::{pin::Pin, time::Duration};

use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};
use reqwest::{header, Client, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::input::InputEnvelope;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalKind {
    Offer,
    Answer,
    Candidate,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SignalEnvelope {
    pub sequence: u64,
    pub from: String,
    pub kind: SignalKind,
    pub payload: Value,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnServer {
    pub uri: String,
}

#[derive(Debug, Deserialize)]
struct IceServerResponse {
    urls: Vec<String>,
    username: String,
    credential: String,
}

#[derive(Debug, Deserialize)]
struct IceConfigurationResponse {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<IceServerResponse>,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SessionEvent {
    pub state: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PortalEvent {
    Session(SessionEvent),
    Signal(SignalEnvelope),
    Input(InputEnvelope),
}

#[derive(Debug, Deserialize)]
struct EventToken {
    #[serde(rename = "accessToken")]
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct AcceptedSignal {
    sequence: u64,
}

#[derive(Debug, Serialize)]
struct SignalRequest<'a> {
    kind: SignalKind,
    payload: &'a Value,
}

#[derive(Debug, Serialize)]
struct HostActionRequest<'a> {
    action: &'a str,
}

#[derive(Debug, Error)]
pub enum PortalError {
    #[error("The BeamDesk portal URL must use HTTPS unless it is a local development URL.")]
    InsecurePortalUrl,
    #[error("The BeamDesk portal URL is invalid: {0}")]
    InvalidUrl(#[from] url::ParseError),
    #[error("The BeamDesk portal request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("The BeamDesk portal returned an invalid signaling envelope: {0}")]
    Envelope(#[from] serde_json::Error),
    #[error("The BeamDesk event stream ended unexpectedly: {0}")]
    EventStream(String),
    #[error("The BeamDesk TURN configuration is invalid: {0}")]
    TurnConfiguration(String),
}

pub type EventStream = Pin<Box<dyn Stream<Item = Result<PortalEvent, PortalError>> + Send>>;

#[derive(Clone)]
pub struct PortalClient {
    base_url: Url,
    http: Client,
}

impl PortalClient {
    pub fn new(portal_url: &str) -> Result<Self, PortalError> {
        let base_url = Url::parse(portal_url)?;
        let local = matches!(base_url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("::1"));
        if base_url.scheme() != "https" && !(base_url.scheme() == "http" && local) {
            return Err(PortalError::InsecurePortalUrl);
        }
        let http = Client::builder().timeout(Duration::from_secs(15)).build()?;
        Ok(Self { base_url, http })
    }

    fn endpoint(&self, session_id: &str, suffix: &str) -> Result<Url, PortalError> {
        Ok(self.base_url.join(&format!("api/sessions/{session_id}/{suffix}"))?)
    }

    fn authenticated(&self, request: reqwest::RequestBuilder, session_token: &str) -> reqwest::RequestBuilder {
        request.header("x-session-token", session_token).header(header::ACCEPT, "application/json")
    }

    async fn json<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder) -> Result<T, PortalError> {
        Ok(request.send().await?.error_for_status()?.json::<T>().await?)
    }

    /// Opens a one-time, role-scoped event credential. The portal independently
    /// gates signaling and host-bound input events by its consent state machine.
    pub async fn subscribe_events(&self, session_id: &str, session_token: &str) -> Result<EventStream, PortalError> {
        let token: EventToken = self
            .json(self.authenticated(self.http.post(self.endpoint(session_id, "event-token")?), session_token))
            .await?;
        let mut event_url = self.endpoint(session_id, "events")?;
        event_url.query_pairs_mut().append_pair("access", &token.access_token);
        let response = self.http.get(event_url).send().await?.error_for_status()?;
        let events = response.bytes_stream().eventsource().filter_map(|event| async move {
            match event {
                Ok(event) if event.event == "signal" => Some(serde_json::from_str(&event.data).map(PortalEvent::Signal).map_err(PortalError::from)),
                Ok(event) if event.event == "session" => Some(serde_json::from_str(&event.data).map(PortalEvent::Session).map_err(PortalError::from)),
                Ok(event) if event.event == "input" => Some(serde_json::from_str(&event.data).map(PortalEvent::Input).map_err(PortalError::from)),
                Ok(_) => None,
                Err(error) => Some(Err(PortalError::EventStream(error.to_string()))),
            }
        });
        Ok(Box::pin(events))
    }

    /// Sends an opaque SDP or ICE envelope. The portal refuses this request until
    /// its host-side state machine has an active view approval.
    pub async fn send_signal(
        &self,
        session_id: &str,
        session_token: &str,
        kind: SignalKind,
        payload: &Value,
    ) -> Result<u64, PortalError> {
        let request = SignalRequest { kind, payload };
        let accepted: AcceptedSignal = self
            .json(self.authenticated(self.http.post(self.endpoint(session_id, "signal")?).json(&request), session_token))
            .await?;
        Ok(accepted.sequence)
    }

    /// Mirrors a completed, local approval into the server-side state machine.
    /// The server still rejects this action unless the session is in the expected
    /// pending state, so this does not bypass the portal’s consent boundary.
    pub async fn send_host_action(&self, session_id: &str, session_token: &str, action: &str) -> Result<(), PortalError> {
        let request = HostActionRequest { action };
        self.authenticated(self.http.post(self.endpoint(session_id, "host-action")?).json(&request), session_token)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Ends the server-side attended session when this host stops locally. The
    /// portal invalidates all role credentials and revokes view/control state.
    pub async fn end_session(&self, session_id: &str, session_token: &str) -> Result<(), PortalError> {
        self.authenticated(self.http.post(self.endpoint(session_id, "end")?), session_token)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Requests only role-scoped, short-lived TURN credentials. The portal owns
    /// the CoTURN shared secret; this host receives only per-session relay URIs.
    pub async fn turn_servers(&self, session_id: &str, session_token: &str) -> Result<Vec<TurnServer>, PortalError> {
        let configuration: IceConfigurationResponse = self
            .json(self.authenticated(self.http.get(self.endpoint(session_id, "ice-config")?), session_token))
            .await?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        if configuration.expires_at <= now {
            return Err(PortalError::TurnConfiguration("the credential is already expired".to_string()));
        }
        configuration.ice_servers.iter()
            .flat_map(|server| server.urls.iter().map(move |url| native_turn_uri(url, &server.username, &server.credential)))
            .collect()
    }
}

fn native_turn_uri(url: &str, username: &str, credential: &str) -> Result<TurnServer, PortalError> {
    let (scheme, remainder) = if let Some(value) = url.strip_prefix("turn:") { ("turn", value) }
        else if let Some(value) = url.strip_prefix("turns:") { ("turns", value) }
        else { return Err(PortalError::TurnConfiguration("the portal returned a non-TURN URL".to_string())); };
    let target = remainder.trim_start_matches('/');
    if target.is_empty() { return Err(PortalError::TurnConfiguration("the portal returned an empty TURN host".to_string())); }
    let encode = |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    Ok(TurnServer { uri: format!("{scheme}://{}:{}@{target}", encode(username), encode(credential)) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_local_http_portal_urls() {
        assert!(matches!(PortalClient::new("http://example.test/"), Err(PortalError::InsecurePortalUrl)));
        assert!(PortalClient::new("http://127.0.0.1:4173/").is_ok());
        assert!(PortalClient::new("https://support.example.test/").is_ok());
    }

    #[test]
    fn derives_the_session_signal_endpoint() {
        let client = PortalClient::new("https://support.example.test/").unwrap();
        assert_eq!(
            client.endpoint("session-123", "signal").unwrap().as_str(),
            "https://support.example.test/api/sessions/session-123/signal"
        );
    }

    #[test]
    fn converts_standard_webrtc_turn_urls_to_gstreamer_turn_uris() {
        let server = native_turn_uri("turns:relay.example.test:5349?transport=tcp", "123:session:host", "a+/=").unwrap();
        assert_eq!(server.uri, "turns://123%3Asession%3Ahost:a%2B%2F%3D@relay.example.test:5349?transport=tcp");
    }
}

//! Wayland capture starts only through the XDG ScreenCast portal.

use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode,
};
use thiserror::Error;

use crate::LocalApprovalState;

/// A live PipeWire source that exists only while the portal session is retained.
pub struct PortalCapture {
    _portal: Screencast,
    _session: ashpd::desktop::Session<Screencast>,
    pipewire_remote: OwnedFd,
    pipewire_node_id: u32,
}

impl PortalCapture {
    pub fn pipewire_fd(&self) -> RawFd {
        self.pipewire_remote.as_raw_fd()
    }

    pub fn pipewire_node_id(&self) -> u32 {
        self.pipewire_node_id
    }
}

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("Local screen-view approval is required before a capture request can be opened.")]
    ApprovalRequired,
    #[error("The desktop portal did not return a display stream after approval.")]
    NoDisplayStream,
    #[error("The XDG ScreenCast portal request failed: {0}")]
    Portal(#[from] ashpd::Error),
}

/// Invokes the compositor-owned picker after BeamDesk has obtained a separate local
/// view approval. `PersistMode::DoNot` intentionally prevents a session from becoming
/// an unattended or remembered capture grant.
pub async fn request_wayland_capture(approval: &LocalApprovalState) -> Result<PortalCapture, CaptureError> {
    if !approval.can_start_capture() {
        return Err(CaptureError::ApprovalRequired);
    }

    let portal = Screencast::new().await?;
    let session = portal.create_session(Default::default()).await?;
    portal
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_sources(SourceType::Monitor | SourceType::Window)
                .set_cursor_mode(CursorMode::Embedded)
                .set_multiple(false)
                .set_persist_mode(PersistMode::DoNot),
        )
        .await?;

    let response = portal.start(&session, None, Default::default()).await?.response()?;
    let stream = response.streams().first().ok_or(CaptureError::NoDisplayStream)?;
    let pipewire_node_id = stream.pipe_wire_node_id();
    let pipewire_remote = portal.open_pipe_wire_remote(&session, Default::default()).await?;

    Ok(PortalCapture {
        _portal: portal,
        _session: session,
        pipewire_remote,
        pipewire_node_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn capture_request_is_blocked_before_local_view_approval() {
        let approval = LocalApprovalState::new();
        assert!(matches!(request_wayland_capture(&approval).await, Err(CaptureError::ApprovalRequired)));
    }
}

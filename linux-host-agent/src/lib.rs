//! Core policy for the attended-only BeamDesk Linux host agent.
//! Attended-only Linux host policy plus portal-approved capture and media building blocks.

pub mod capture;
pub mod input;
pub mod media;
pub mod portal;
pub mod x11;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DisplayPath {
    WaylandPortal,
    X11Compatibility,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinuxCapabilities {
    pub display_path: DisplayPath,
    pub can_request_view: bool,
    pub can_request_control: bool,
    pub explanation: &'static str,
}

/// Determines the safe host path from only local desktop-session variables.
/// Wayland must use the XDG portal so the compositor can show its own consent
/// dialog; this scaffold does not silently fall back to raw capture APIs.
pub fn detect_capabilities(wayland_display: Option<&str>, display: Option<&str>, portal_available: bool) -> LinuxCapabilities {
    if wayland_display.is_some() && portal_available {
        return LinuxCapabilities {
            display_path: DisplayPath::WaylandPortal,
            can_request_view: true,
            can_request_control: true,
            explanation: "Wayland portal is available. The desktop environment will present the display and input permission dialog.",
        };
    }
    if wayland_display.is_some() {
        return LinuxCapabilities {
            display_path: DisplayPath::Unsupported,
            can_request_view: false,
            can_request_control: false,
            explanation: "Wayland was detected, but the XDG desktop portal is unavailable. BeamDesk will not bypass compositor consent.",
        };
    }
    if display.is_some() {
        return LinuxCapabilities {
            display_path: DisplayPath::X11Compatibility,
            can_request_view: true,
            can_request_control: true,
            explanation: "X11 compatibility mode is available. Capture and virtual input still require local session permission checks.",
        };
    }
    LinuxCapabilities {
        display_path: DisplayPath::Unsupported,
        can_request_view: false,
        can_request_control: false,
        explanation: "No supported interactive Linux desktop session was detected.",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPermission {
    None,
    ViewOnly,
    Control,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalApprovalState {
    pub joined: bool,
    pub permission: HostPermission,
}

impl LocalApprovalState {
    pub fn new() -> Self { Self { joined: false, permission: HostPermission::None } }
    pub fn join(&mut self) { self.joined = true; self.permission = HostPermission::None; }
    pub fn approve_view(&mut self) -> Result<(), &'static str> {
        if !self.joined { return Err("A support code must be joined before approving view."); }
        self.permission = HostPermission::ViewOnly;
        Ok(())
    }
    pub fn approve_control(&mut self) -> Result<(), &'static str> {
        if self.permission != HostPermission::ViewOnly { return Err("Screen viewing must be approved before remote control."); }
        self.permission = HostPermission::Control;
        Ok(())
    }
    pub fn revoke_control(&mut self) { if self.permission == HostPermission::Control { self.permission = HostPermission::ViewOnly; } }
    pub fn end(&mut self) { self.joined = false; self.permission = HostPermission::None; }

    /// Native display capture is never available before an explicit local view approval.
    pub fn can_start_capture(&self) -> bool {
        self.joined && matches!(self.permission, HostPermission::ViewOnly | HostPermission::Control)
    }

    /// Native input injection is never available until view and control have both
    /// been approved locally. Capture-only approval is intentionally insufficient.
    pub fn can_inject_input(&self) -> bool {
        self.joined && self.permission == HostPermission::Control
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_without_a_portal_is_refused_instead_of_bypassing_user_consent() {
        let capabilities = detect_capabilities(Some("wayland-0"), None, false);
        assert_eq!(capabilities.display_path, DisplayPath::Unsupported);
        assert!(!capabilities.can_request_view);
    }

    #[test]
    fn control_requires_a_separate_view_approval() {
        let mut state = LocalApprovalState::new();
        state.join();
        assert!(state.approve_control().is_err());
        state.approve_view().unwrap();
        state.approve_control().unwrap();
        assert_eq!(state.permission, HostPermission::Control);
        state.revoke_control();
        assert_eq!(state.permission, HostPermission::ViewOnly);
    }

    #[test]
    fn capture_requires_local_view_approval() {
        let mut state = LocalApprovalState::new();
        assert!(!state.can_start_capture());
        state.join();
        assert!(!state.can_start_capture());
        state.approve_view().unwrap();
        assert!(state.can_start_capture());
        assert!(!state.can_inject_input());
        state.approve_control().unwrap();
        assert!(state.can_inject_input());
        state.end();
        assert!(!state.can_start_capture());
        assert!(!state.can_inject_input());
    }
}

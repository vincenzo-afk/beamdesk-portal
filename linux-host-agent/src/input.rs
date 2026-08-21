//! Separate, portal-mediated remote input for an attended Wayland host.

use ashpd::desktop::{
    remote_desktop::{
        DeviceType, KeyState, NotifyKeyboardKeycodeOptions, NotifyPointerAxisOptions,
        NotifyPointerButtonOptions, NotifyPointerMotionOptions, RemoteDesktop, SelectDevicesOptions,
    },
    Session,
};
use serde::Deserialize;
use thiserror::Error;

use crate::LocalApprovalState;

const BTN_LEFT: i32 = 272;
const BTN_RIGHT: i32 = 273;
const BTN_MIDDLE: i32 = 274;
const POINTER_X_SPAN: f64 = 1920.0;
const POINTER_Y_SPAN: f64 = 1080.0;
const MAX_RELATIVE_POINTER_DELTA: f64 = 320.0;
const MAX_SCROLL_DELTA: f64 = 120.0;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct InputEnvelope {
    pub sequence: u64,
    pub events: Vec<InputEvent>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InputEvent {
    Move { x: f64, y: f64 },
    Button { button: String, down: bool },
    Key { code: String, down: bool },
    Wheel {
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
}

#[derive(Debug, Error)]
pub enum InputError {
    #[error("Local view and control approval are both required before input can be requested.")]
    ApprovalRequired,
    #[error("The desktop portal did not grant keyboard and pointer access: {0}")]
    Portal(#[from] ashpd::Error),
    #[error("The input envelope was stale or duplicated.")]
    StaleEnvelope,
    #[error("BeamDesk does not inject the unsupported keyboard code `{0}`.")]
    UnsupportedKey(String),
    #[error("BeamDesk does not inject the unsupported pointer button `{0}`.")]
    UnsupportedButton(String),
}

#[derive(Debug, Default)]
struct PointerMapper {
    last_normalized: Option<(f64, f64)>,
}

impl PointerMapper {
    fn relative_delta(&mut self, x: f64, y: f64) -> Option<(f64, f64)> {
        let x = x.clamp(0.0, 1.0);
        let y = y.clamp(0.0, 1.0);
        let previous = self.last_normalized.replace((x, y))?;
        Some(((x - previous.0) * POINTER_X_SPAN, (y - previous.1) * POINTER_Y_SPAN))
    }
}

fn key_state(down: bool) -> KeyState {
    if down { KeyState::Pressed } else { KeyState::Released }
}

fn linux_keycode(code: &str) -> Option<i32> {
    match code {
        "KeyA" => return Some(30), "KeyB" => return Some(48), "KeyC" => return Some(46), "KeyD" => return Some(32),
        "KeyE" => return Some(18), "KeyF" => return Some(33), "KeyG" => return Some(34), "KeyH" => return Some(35),
        "KeyI" => return Some(23), "KeyJ" => return Some(36), "KeyK" => return Some(37), "KeyL" => return Some(38),
        "KeyM" => return Some(50), "KeyN" => return Some(49), "KeyO" => return Some(24), "KeyP" => return Some(25),
        "KeyQ" => return Some(16), "KeyR" => return Some(19), "KeyS" => return Some(31), "KeyT" => return Some(20),
        "KeyU" => return Some(22), "KeyV" => return Some(47), "KeyW" => return Some(17), "KeyX" => return Some(45),
        "KeyY" => return Some(21), "KeyZ" => return Some(44), _ => {}
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        if digit.len() == 1 {
            let value = digit.as_bytes()[0];
            if value.is_ascii_digit() { return Some(if value == b'0' { 11 } else { i32::from(value - b'0') + 1 }); }
        }
    }
    match code {
        "Enter" => Some(28), "Escape" => Some(1), "Backspace" => Some(14), "Tab" => Some(15), "Space" => Some(57),
        "ArrowUp" => Some(103), "ArrowDown" => Some(108), "ArrowLeft" => Some(105), "ArrowRight" => Some(106),
        "ShiftLeft" => Some(42), "ShiftRight" => Some(54), "ControlLeft" => Some(29), "ControlRight" => Some(97),
        "AltLeft" => Some(56), "AltRight" => Some(100), "MetaLeft" => Some(125), "MetaRight" => Some(126),
        "Delete" => Some(111), "Home" => Some(102), "End" => Some(107), "PageUp" => Some(104), "PageDown" => Some(109),
        _ => None,
    }
}

fn linux_button(button: &str) -> Option<i32> {
    match button { "left" => Some(BTN_LEFT), "right" => Some(BTN_RIGHT), "middle" => Some(BTN_MIDDLE), _ => None }
}

/// Retains the XDG RemoteDesktop session for as long as the local host allows
/// remote control. Drop closes the D-Bus session, immediately revoking injection.
pub struct PortalInputController {
    portal: RemoteDesktop,
    session: Session<RemoteDesktop>,
    last_sequence: Option<u64>,
    pointer: PointerMapper,
}

impl PortalInputController {
    /// The desktop portal displays its own keyboard/pointer consent dialog. This is
    /// called only after the user has separately approved the BeamDesk control prompt.
    pub async fn request(approval: &LocalApprovalState) -> Result<Self, InputError> {
        if !approval.can_inject_input() { return Err(InputError::ApprovalRequired); }
        let portal = RemoteDesktop::new().await?;
        let session = portal.create_session(Default::default()).await?;
        portal
            .select_devices(&session, SelectDevicesOptions::default().set_devices(DeviceType::Keyboard | DeviceType::Pointer))
            .await?;
        portal.start(&session, None, Default::default()).await?.response()?;
        Ok(Self {
            portal,
            session,
            last_sequence: None,
            pointer: PointerMapper::default(),
        })
    }

    pub async fn apply(&mut self, envelope: InputEnvelope) -> Result<(), InputError> {
        if self.last_sequence.is_some_and(|previous| envelope.sequence <= previous) { return Err(InputError::StaleEnvelope); }
        for event in envelope.events {
            match event {
                InputEvent::Move { x, y } => {
                    if let Some((dx, dy)) = self.pointer.relative_delta(x, y) {
                        self.portal.notify_pointer_motion(
                            &self.session,
                            dx.clamp(-MAX_RELATIVE_POINTER_DELTA, MAX_RELATIVE_POINTER_DELTA),
                            dy.clamp(-MAX_RELATIVE_POINTER_DELTA, MAX_RELATIVE_POINTER_DELTA),
                            NotifyPointerMotionOptions::default(),
                        ).await?;
                    }
                }
                InputEvent::Button { button, down } => {
                    let button = linux_button(&button).ok_or(InputError::UnsupportedButton(button))?;
                    self.portal.notify_pointer_button(&self.session, button, key_state(down), NotifyPointerButtonOptions::default()).await?;
                }
                InputEvent::Key { code, down } => {
                    let keycode = linux_keycode(&code).ok_or(InputError::UnsupportedKey(code))?;
                    self.portal.notify_keyboard_keycode(&self.session, keycode, key_state(down), NotifyKeyboardKeycodeOptions::default()).await?;
                }
                InputEvent::Wheel { delta_x, delta_y } => {
                    self.portal.notify_pointer_axis(
                        &self.session,
                        delta_x.clamp(-MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
                        delta_y.clamp(-MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
                        NotifyPointerAxisOptions::default().set_finish(true),
                    ).await?;
                }
            }
        }
        self.last_sequence = Some(envelope.sequence);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_known_browser_codes_to_linux_evdev_codes() {
        assert_eq!(linux_keycode("KeyA"), Some(30));
        assert_eq!(linux_keycode("KeyQ"), Some(16));
        assert_eq!(linux_keycode("Digit1"), Some(2));
        assert_eq!(linux_keycode("Digit0"), Some(11));
        assert_eq!(linux_keycode("<script>"), None);
    }

    #[test]
    fn first_normalized_pointer_position_only_establishes_a_safe_baseline() {
        let mut mapper = PointerMapper::default();
        assert_eq!(mapper.relative_delta(0.5, 0.5), None);
        let (dx, dy) = mapper.relative_delta(0.6, 0.4).unwrap();
        assert!((dx - 192.0).abs() < 1e-9);
        assert!((dy + 108.0).abs() < 1e-9);
    }

    #[test]
    fn canonical_browser_input_deserializes_without_accepting_extra_event_kinds() {
        let envelope: InputEnvelope = serde_json::from_str(r#"{"sequence":7,"events":[{"kind":"button","button":"left","down":true},{"kind":"key","code":"KeyA","down":false}]}"#).unwrap();
        assert_eq!(envelope.sequence, 7);
        assert_eq!(envelope.events.len(), 2);
        assert!(serde_json::from_str::<InputEnvelope>(r#"{"sequence":8,"events":[{"kind":"clipboard","text":"no"}]}"#).is_err());
    }

    #[tokio::test]
    async fn input_portal_request_is_blocked_without_distinct_local_control_approval() {
        let mut approval = LocalApprovalState::new();
        approval.join();
        approval.approve_view().unwrap();
        assert!(matches!(PortalInputController::request(&approval).await, Err(InputError::ApprovalRequired)));
    }
}

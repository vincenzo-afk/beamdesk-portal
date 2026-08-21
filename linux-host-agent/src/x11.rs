//! X11 compatibility support. This module is deliberately unavailable on Wayland
//! and only starts after the same separate BeamDesk view/control approval boundary.

use std::collections::BTreeSet;

use thiserror::Error;
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::Window,
        xtest::ConnectionExt as _,
    },
    rust_connection::RustConnection,
};

use crate::{input::{InputEnvelope, InputEvent}, LocalApprovalState};

const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;
const MAX_SCROLL_STEPS: usize = 3;

#[derive(Debug, Error)]
pub enum X11InputError {
    #[error("Local view and control approval are both required before X11 input can start.")]
    ApprovalRequired,
    #[error("The X11 display could not be opened or does not provide XTEST: {0}")]
    X11(String),
    #[error("The input envelope was stale or duplicated.")]
    StaleEnvelope,
    #[error("BeamDesk does not inject the unsupported keyboard code `{0}` into X11.")]
    UnsupportedKey(String),
    #[error("BeamDesk does not inject the unsupported pointer button `{0}` into X11.")]
    UnsupportedButton(String),
}

/// A short-lived X11 virtual-input session. It is created from the local
/// interactive `DISPLAY` only and releases every BeamDesk-held key/button when
/// dropped. It never opens a display supplied by an operator.
pub struct X11InputController {
    connection: RustConnection,
    root: Window,
    width: u16,
    height: u16,
    last_sequence: Option<u64>,
    pressed_keys: BTreeSet<u8>,
    pressed_buttons: BTreeSet<u8>,
}

/// Confirms that the locally inherited interactive X display can be reached for
/// capture. This deliberately performs no input injection and accepts no remote
/// display name.
pub fn verify_local_display(local_display: &str) -> Result<(), X11InputError> {
    let (connection, screen_number) = x11rb::connect(Some(local_display))
        .map_err(|error| X11InputError::X11(error.to_string()))?;
    let screen = &connection.setup().roots[screen_number];
    if screen.width_in_pixels == 0 || screen.height_in_pixels == 0 {
        return Err(X11InputError::X11("The X11 display has no usable screen dimensions.".to_string()));
    }
    Ok(())
}

impl X11InputController {
    pub fn connect(local_display: &str, approval: &LocalApprovalState) -> Result<Self, X11InputError> {
        if !approval.can_inject_input() {
            return Err(X11InputError::ApprovalRequired);
        }
        let (connection, screen_number) = x11rb::connect(Some(local_display))
            .map_err(|error| X11InputError::X11(error.to_string()))?;
        connection.xtest_get_version(2, 2)
            .map_err(|error| X11InputError::X11(error.to_string()))?
            .reply()
            .map_err(|error| X11InputError::X11(error.to_string()))?;
        let (root, width, height) = {
            let screen = &connection.setup().roots[screen_number];
            (screen.root, screen.width_in_pixels, screen.height_in_pixels)
        };
        Ok(Self {
            connection,
            root,
            width,
            height,
            last_sequence: None,
            pressed_keys: BTreeSet::new(),
            pressed_buttons: BTreeSet::new(),
        })
    }

    pub fn apply(&mut self, envelope: InputEnvelope) -> Result<(), X11InputError> {
        if self.last_sequence.is_some_and(|last| envelope.sequence <= last) {
            return Err(X11InputError::StaleEnvelope);
        }
        for event in envelope.events {
            match event {
                InputEvent::Move { x, y } => self.move_pointer(x, y)?,
                InputEvent::Button { button, down } => self.button(&button, down)?,
                InputEvent::Key { code, down } => self.key(&code, down)?,
                InputEvent::Wheel { delta_x, delta_y } => self.wheel(delta_x, delta_y)?,
            }
        }
        self.connection.flush().map_err(|error| X11InputError::X11(error.to_string()))?;
        self.last_sequence = Some(envelope.sequence);
        Ok(())
    }

    fn fake_input(&self, event_type: u8, detail: u8, x: i16, y: i16) -> Result<(), X11InputError> {
        self.connection.xtest_fake_input(event_type, detail, 0, self.root, x, y, 0)
            .map_err(|error| X11InputError::X11(error.to_string()))?;
        Ok(())
    }

    fn move_pointer(&self, x: f64, y: f64) -> Result<(), X11InputError> {
        let x = (x.clamp(0.0, 1.0) * f64::from(self.width.saturating_sub(1))) as i16;
        let y = (y.clamp(0.0, 1.0) * f64::from(self.height.saturating_sub(1))) as i16;
        self.fake_input(MOTION_NOTIFY, 0, x, y)
    }

    fn button(&mut self, button: &str, down: bool) -> Result<(), X11InputError> {
        let detail = x11_button(button).ok_or_else(|| X11InputError::UnsupportedButton(button.to_string()))?;
        self.fake_input(if down { BUTTON_PRESS } else { BUTTON_RELEASE }, detail, 0, 0)?;
        if down { self.pressed_buttons.insert(detail); } else { self.pressed_buttons.remove(&detail); }
        Ok(())
    }

    fn key(&mut self, code: &str, down: bool) -> Result<(), X11InputError> {
        let detail = x11_keycode(code).ok_or_else(|| X11InputError::UnsupportedKey(code.to_string()))?;
        self.fake_input(if down { KEY_PRESS } else { KEY_RELEASE }, detail, 0, 0)?;
        if down { self.pressed_keys.insert(detail); } else { self.pressed_keys.remove(&detail); }
        Ok(())
    }

    fn wheel(&mut self, delta_x: f64, delta_y: f64) -> Result<(), X11InputError> {
        for (delta, positive, negative) in [(delta_y, 4u8, 5u8), (delta_x, 6u8, 7u8)] {
            let steps = (delta.abs() / 40.0).ceil().clamp(0.0, MAX_SCROLL_STEPS as f64) as usize;
            let detail = if delta < 0.0 { positive } else { negative };
            for _ in 0..steps {
                self.fake_input(BUTTON_PRESS, detail, 0, 0)?;
                self.fake_input(BUTTON_RELEASE, detail, 0, 0)?;
            }
        }
        Ok(())
    }

    fn release_all(&mut self) {
        for key in std::mem::take(&mut self.pressed_keys) {
            let _ = self.fake_input(KEY_RELEASE, key, 0, 0);
        }
        for button in std::mem::take(&mut self.pressed_buttons) {
            let _ = self.fake_input(BUTTON_RELEASE, button, 0, 0);
        }
        let _ = self.connection.flush();
    }
}

impl Drop for X11InputController {
    fn drop(&mut self) { self.release_all(); }
}

fn x11_button(button: &str) -> Option<u8> {
    match button { "left" => Some(1), "middle" => Some(2), "right" => Some(3), _ => None }
}

/// Xorg’s normal core-keycode layout reserves an eight-code offset above the
/// Linux evdev code. Unknown browser codes are rejected rather than guessed.
fn x11_keycode(code: &str) -> Option<u8> {
    let evdev = match code {
        "KeyA" => 30, "KeyB" => 48, "KeyC" => 46, "KeyD" => 32, "KeyE" => 18, "KeyF" => 33,
        "KeyG" => 34, "KeyH" => 35, "KeyI" => 23, "KeyJ" => 36, "KeyK" => 37, "KeyL" => 38,
        "KeyM" => 50, "KeyN" => 49, "KeyO" => 24, "KeyP" => 25, "KeyQ" => 16, "KeyR" => 19,
        "KeyS" => 31, "KeyT" => 20, "KeyU" => 22, "KeyV" => 47, "KeyW" => 17, "KeyX" => 45,
        "KeyY" => 21, "KeyZ" => 44, "Enter" => 28, "Escape" => 1, "Backspace" => 14,
        "Tab" => 15, "Space" => 57, "ArrowUp" => 103, "ArrowDown" => 108, "ArrowLeft" => 105,
        "ArrowRight" => 106, "ShiftLeft" => 42, "ShiftRight" => 54, "ControlLeft" => 29,
        "ControlRight" => 97, "AltLeft" => 56, "AltRight" => 100, "MetaLeft" => 125,
        "MetaRight" => 126, "Delete" => 111, "Home" => 102, "End" => 107, "PageUp" => 104,
        "PageDown" => 109, _ => {
            let digit = code.strip_prefix("Digit")?;
            if digit.len() != 1 || !digit.as_bytes()[0].is_ascii_digit() { return None; }
            if digit == "0" { 11 } else { i32::from(digit.as_bytes()[0] - b'0') + 1 }
        }
    };
    u8::try_from(evdev + 8).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_canonical_browser_codes_to_x11_core_keycodes() {
        assert_eq!(x11_keycode("KeyA"), Some(38));
        assert_eq!(x11_keycode("Digit1"), Some(10));
        assert_eq!(x11_keycode("clipboard"), None);
    }

    #[test]
    fn maps_only_supported_pointer_buttons() {
        assert_eq!(x11_button("left"), Some(1));
        assert_eq!(x11_button("right"), Some(3));
        assert_eq!(x11_button("back"), None);
    }
}

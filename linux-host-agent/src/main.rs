use std::{
    env,
    io::{self, Write},
    time::Duration,
};

use beamdesk_linux_host::{
    capture::request_wayland_capture,
    detect_capabilities,
    input::PortalInputController,
    media::NativeWebRtcSender,
    portal::{PortalClient, PortalEvent},
    DisplayPath,
    LocalApprovalState,
};
use futures_util::StreamExt;
use tokio::sync::mpsc;

struct RunConfig {
    portal_url: String,
    session_id: String,
    session_token: String,
}

fn run_config_from_env() -> Result<RunConfig, &'static str> {
    Ok(RunConfig {
        portal_url: env::var("BEAMDESK_PORTAL_URL").map_err(|_| "BEAMDESK_PORTAL_URL is required.")?,
        session_id: env::var("BEAMDESK_SESSION_ID").map_err(|_| "BEAMDESK_SESSION_ID is required.")?,
        session_token: env::var("BEAMDESK_SESSION_TOKEN").map_err(|_| "BEAMDESK_SESSION_TOKEN is required.")?,
    })
}

fn confirm_display_share() -> bool {
    print!("Type SHARE to open the desktop display picker (anything else cancels): ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).is_ok() && answer.trim().eq_ignore_ascii_case("share")
}

fn confirm_remote_control() -> bool {
    print!("A supporter requested keyboard and pointer control. Type CONTROL to open the desktop permission dialog (anything else declines): ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).is_ok() && answer.trim().eq_ignore_ascii_case("control")
}

/// This CLI is an attended development host. It never captures a display, enables
/// remote input, or starts media transport before distinct local confirmations and
/// compositor-owned portal dialogs complete.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let capabilities = detect_capabilities(
        env::var("WAYLAND_DISPLAY").ok().as_deref(),
        env::var("DISPLAY").ok().as_deref(),
        env::var("BEAMDESK_PORTAL_AVAILABLE").as_deref() == Ok("1"),
    );
    let mut approval = LocalApprovalState::new();
    approval.join();
    println!("BeamDesk Linux Host — attended support only");
    println!("Display path: {:?}", capabilities.display_path);
    println!("{}", capabilities.explanation);

    if capabilities.display_path != DisplayPath::WaylandPortal {
        eprintln!("This Linux runtime is Wayland-only. It will not fall back to a raw capture or input API.");
        std::process::exit(2);
    }

    let config = match run_config_from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            eprintln!("Obtain the host session credentials through the attended BeamDesk join flow before starting this development host.");
            std::process::exit(2);
        }
    };

    if !confirm_display_share() {
        println!("Display sharing was not approved locally. Nothing was captured or sent.");
        return;
    }
    approval.approve_view().expect("The host joined before the local confirmation prompt.");

    let portal = match PortalClient::new(&config.portal_url) {
        Ok(portal) => portal,
        Err(error) => {
            eprintln!("Portal configuration failed: {error}");
            return;
        }
    };

    // The source picker must complete before the server-side view approval. If the
    // picker is cancelled, the operator never receives an active media path.
    let capture = match request_wayland_capture(&approval).await {
        Ok(capture) => capture,
        Err(error) => {
            eprintln!("Display selection was not completed: {error}");
            return;
        }
    };

    if let Err(error) = portal.send_host_action(&config.session_id, &config.session_token, "approve-view").await {
        eprintln!("The view approval was not accepted by the current BeamDesk session: {error}");
        return;
    }

    let mut inbound = match portal.subscribe_events(&config.session_id, &config.session_token).await {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("The approved session event stream could not be opened: {error}");
            return;
        }
    };
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel();
    let turn_servers = match portal.turn_servers(&config.session_id, &config.session_token).await {
        Ok(turn_servers) => turn_servers,
        Err(error) => {
            eprintln!("TURN relay credentials are unavailable; trying direct connectivity only: {error}");
            Vec::new()
        }
    };
    let sender = match NativeWebRtcSender::start(&capture, outbound_tx, &turn_servers) {
        Ok(sender) => sender,
        Err(error) => {
            eprintln!("The local encrypted media sender could not start: {error}");
            return;
        }
    };

    println!("Display sharing is active. Keep this terminal open; closing it revokes the local capture source.");
    let glib_context = gstreamer::glib::MainContext::default();
    let mut glib_tick = tokio::time::interval(Duration::from_millis(10));
    let mut input: Option<PortalInputController> = None;
    let mut control_prompted = false;

    loop {
        tokio::select! {
            _ = glib_tick.tick() => {
                while glib_context.pending() { glib_context.iteration(false); }
            }
            Some(event) = inbound.next() => match event {
                Ok(PortalEvent::Signal(envelope)) => {
                    if let Err(error) = sender.handle_signal(envelope.kind, &envelope.payload) {
                        eprintln!("A remote WebRTC signal was rejected: {error}");
                        break;
                    }
                }
                Ok(PortalEvent::Input(envelope)) => {
                    if let Some(controller) = input.as_mut() {
                        if let Err(error) = controller.apply(envelope).await {
                            eprintln!("A validated remote-control event was not injected: {error}");
                            break;
                        }
                    } else {
                        eprintln!("An input event arrived without a local portal control grant and was ignored.");
                    }
                }
                Ok(PortalEvent::Session(session)) => {
                    if matches!(session.state.as_str(), "ENDED" | "EXPIRED") { break; }
                    if session.state == "VIEW_ACTIVE" {
                        if input.take().is_some() { println!("Remote control was revoked; screen viewing remains active."); }
                        approval.revoke_control();
                        control_prompted = false;
                    }
                    if session.state == "CONTROL_PENDING" && !control_prompted {
                        control_prompted = true;
                        let locally_confirmed = tokio::task::spawn_blocking(confirm_remote_control).await.unwrap_or(false);
                        if !locally_confirmed {
                            let _ = portal.send_host_action(&config.session_id, &config.session_token, "deny-control").await;
                            println!("Remote control was declined locally. Screen viewing remains active.");
                            continue;
                        }
                        if let Err(error) = approval.approve_control() {
                            eprintln!("The local control boundary refused approval: {error}");
                            let _ = portal.send_host_action(&config.session_id, &config.session_token, "deny-control").await;
                            continue;
                        }
                        match PortalInputController::request(&approval).await {
                            Ok(controller) => {
                                if let Err(error) = portal.send_host_action(&config.session_id, &config.session_token, "approve-control").await {
                                    approval.revoke_control();
                                    eprintln!("The local desktop granted control, but the BeamDesk session no longer accepted it: {error}");
                                } else {
                                    input = Some(controller);
                                    println!("Remote keyboard and pointer control is active. Close this host or revoke control to stop it.");
                                }
                            }
                            Err(error) => {
                                approval.revoke_control();
                                let _ = portal.send_host_action(&config.session_id, &config.session_token, "deny-control").await;
                                eprintln!("The desktop portal did not approve remote control: {error}");
                            }
                        }
                    }
                }
                Err(error) => {
                    eprintln!("The approved session event stream failed: {error}");
                    break;
                }
            },
            Some(signal) = outbound_rx.recv() => {
                if let Err(error) = portal.send_signal(&config.session_id, &config.session_token, signal.kind, &signal.payload).await {
                    eprintln!("A local WebRTC signal could not be relayed: {error}");
                    break;
                }
            }
            else => break,
        }
    }

    let _ = sender.stop();
    drop(input);
    println!("Display sharing and any portal-mediated remote control are stopped.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_requires_all_role_scoped_session_values() {
        assert!(run_config_from_env().is_err());
    }
}

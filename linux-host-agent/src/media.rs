//! GStreamer WebRTC sender for a portal-approved PipeWire display stream.

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::mpsc;

use crate::{capture::PortalCapture, portal::{SignalKind, TurnServer}};

#[derive(Debug, Clone, PartialEq)]
pub struct OutboundSignal {
    pub kind: SignalKind,
    pub payload: Value,
}

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("GStreamer initialization failed: {0}")]
    Initialize(String),
    #[error("The media pipeline could not be created: {0}")]
    Pipeline(String),
    #[error("The media pipeline has no WebRTC element.")]
    MissingWebRtcElement,
    #[error("The WebRTC sender rejected a TURN server URI.")]
    TurnServer,
    #[error("The incoming WebRTC signal does not contain a valid {0} payload.")]
    InvalidSignal(&'static str),
    #[error("The incoming SDP could not be parsed: {0}")]
    Sdp(String),
    #[error("The WebRTC media sender has already stopped.")]
    Stopped,
}

/// Build the media graph from numeric values only; neither an SDP nor a portal
/// response is interpolated into the pipeline string.
pub fn sender_pipeline_description(pipewire_fd: i32, pipewire_node_id: u32) -> String {
    format!(concat!(
        "pipewiresrc fd={pipewire_fd} path={pipewire_node_id} do-timestamp=true ! ",
        "queue max-size-buffers=2 leaky=downstream ! videoconvert ! videoscale ! ",
        "video/x-raw,format=I420,framerate=30/1 ! vp8enc deadline=1 keyframe-max-dist=60 threads=4 ! ",
        "rtpvp8pay pt=96 picture-id-mode=15-bit ! queue ! ",
        "application/x-rtp,media=video,encoding-name=VP8,payload=96 ! ",
        "webrtcbin name=beamdeskwebrtc bundle-policy=max-bundle"
    ), pipewire_fd = pipewire_fd, pipewire_node_id = pipewire_node_id)
}

fn construct_sender_pipeline_with_source(source: gst::Element) -> Result<(gst::Pipeline, gst::Element), MediaError> {
    let pipeline = gst::Pipeline::new();
    let queue_in = gst::ElementFactory::make("queue").name("beamdeskqueuein").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    queue_in.set_property("max-size-buffers", 2u32);
    queue_in.set_property_from_str("leaky", "downstream");
    let convert = gst::ElementFactory::make("videoconvert").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    let scale = gst::ElementFactory::make("videoscale").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    let caps_filter = gst::ElementFactory::make("capsfilter").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    caps_filter.set_property("caps", gst::Caps::builder("video/x-raw")
        .field("format", "I420")
        .field("framerate", gst::Fraction::new(30, 1))
        .build());
    let encoder = gst::ElementFactory::make("vp8enc").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    encoder.set_property("deadline", 1i64);
    encoder.set_property("keyframe-max-dist", 60i32);
    encoder.set_property("threads", 4i32);
    let payloader = gst::ElementFactory::make("rtpvp8pay").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    payloader.set_property("pt", 96u32);
    payloader.set_property_from_str("picture-id-mode", "15-bit");
    let queue_out = gst::ElementFactory::make("queue").name("beamdeskqueueout").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    let webrtcbin = gst::ElementFactory::make("webrtcbin").name("beamdeskwebrtc").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    webrtcbin.set_property_from_str("bundle-policy", "max-bundle");

    pipeline.add_many([&source, &queue_in, &convert, &scale, &caps_filter, &encoder, &payloader, &queue_out, &webrtcbin])
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    gst::Element::link_many([&source, &queue_in, &convert, &scale, &caps_filter, &encoder, &payloader, &queue_out])
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    let queue_src = queue_out.static_pad("src").ok_or_else(|| MediaError::Pipeline("The RTP queue has no source pad.".to_string()))?;
    let webrtc_sink = webrtcbin.request_pad_simple("sink_%u")
        .ok_or_else(|| MediaError::Pipeline("webrtcbin did not create an RTP sink pad.".to_string()))?;
    queue_src.link(&webrtc_sink).map_err(|error| MediaError::Pipeline(error.to_string()))?;

    Ok((pipeline, webrtcbin))
}

fn construct_sender_pipeline(pipewire_fd: i32, pipewire_node_id: u32) -> Result<(gst::Pipeline, gst::Element), MediaError> {
    let pipewire = gst::ElementFactory::make("pipewiresrc").name("beamdeskpipewire").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    pipewire.set_property("fd", pipewire_fd);
    pipewire.set_property("path", pipewire_node_id.to_string());
    pipewire.set_property("do-timestamp", true);
    construct_sender_pipeline_with_source(pipewire)
}

/// X11 is an explicit compatibility source. Callers must first verify the local
/// interactive display and must never pass an operator-provided display name.
fn construct_x11_sender_pipeline(local_display: &str) -> Result<(gst::Pipeline, gst::Element), MediaError> {
    let ximage = gst::ElementFactory::make("ximagesrc").name("beamdeskx11").build()
        .map_err(|error| MediaError::Pipeline(error.to_string()))?;
    ximage.set_property("display-name", local_display);
    ximage.set_property("show-pointer", true);
    ximage.set_property("use-damage", true);
    ximage.set_property("do-timestamp", true);
    construct_sender_pipeline_with_source(ximage)
}

/// Owns the active GStreamer graph. Dropping it moves the graph to `Null`, which
/// releases the PipeWire capture source immediately.
pub struct NativeWebRtcSender {
    pipeline: gst::Pipeline,
    webrtcbin: gst::Element,
    outbound: mpsc::UnboundedSender<OutboundSignal>,
}

impl NativeWebRtcSender {
    pub fn start(capture: &PortalCapture, outbound: mpsc::UnboundedSender<OutboundSignal>, turn_servers: &[TurnServer]) -> Result<Self, MediaError> {
        gst::init().map_err(|error| MediaError::Initialize(error.to_string()))?;
        let (pipeline, webrtcbin) = construct_sender_pipeline(capture.pipewire_fd(), capture.pipewire_node_id())?;
        Self::start_from_pipeline(pipeline, webrtcbin, outbound, turn_servers)
    }

    /// Starts a compatibility X11 source after the caller has completed the same
    /// local view approval used by Wayland. This function does not probe or open a
    /// display by itself; the host’s X11 adapter owns that safety check.
    pub fn start_x11(local_display: &str, outbound: mpsc::UnboundedSender<OutboundSignal>, turn_servers: &[TurnServer]) -> Result<Self, MediaError> {
        gst::init().map_err(|error| MediaError::Initialize(error.to_string()))?;
        let (pipeline, webrtcbin) = construct_x11_sender_pipeline(local_display)?;
        Self::start_from_pipeline(pipeline, webrtcbin, outbound, turn_servers)
    }

    fn start_from_pipeline(pipeline: gst::Pipeline, webrtcbin: gst::Element, outbound: mpsc::UnboundedSender<OutboundSignal>, turn_servers: &[TurnServer]) -> Result<Self, MediaError> {
        for server in turn_servers {
            if !webrtcbin.emit_by_name::<bool>("add-turn-server", &[&server.uri]) {
                return Err(MediaError::TurnServer);
            }
        }

        let ice_outbound = outbound.clone();
        let _ice_handler = webrtcbin.connect("on-ice-candidate", false, move |values| {
                let mline_index = values[1].get::<u32>().expect("webrtcbin must emit a u32 m-line index");
                let candidate = values[2].get::<String>().expect("webrtcbin must emit an ICE candidate string");
                let _ = ice_outbound.send(OutboundSignal {
                    kind: SignalKind::Candidate,
                    payload: json!({ "candidate": candidate, "sdpMLineIndex": mline_index }),
                });
                None
            });

        pipeline
            .set_state(gst::State::Playing)
            .map_err(|error| MediaError::Pipeline(error.to_string()))?;

        Ok(Self { pipeline, webrtcbin, outbound })
    }

    /// Accepts browser-originated offer/candidate envelopes. The native sender
    /// deliberately ignores answers and unknown kinds because the browser is the
    /// initiating peer for the current BeamDesk viewer protocol.
    pub fn handle_signal(&self, kind: SignalKind, payload: &Value) -> Result<(), MediaError> {
        match kind {
            SignalKind::Offer => self.handle_offer(payload),
            SignalKind::Candidate => self.handle_candidate(payload),
            SignalKind::Answer => Ok(()),
        }
    }

    fn handle_offer(&self, payload: &Value) -> Result<(), MediaError> {
        let sdp = payload.get("sdp").and_then(Value::as_str).ok_or(MediaError::InvalidSignal("offer"))?;
        let message = gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes()).map_err(|error| MediaError::Sdp(error.to_string()))?;
        let offer = gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Offer, message);
        self.webrtcbin.emit_by_name::<()>("set-remote-description", &[&offer, &None::<gst::Promise>]);

        let webrtcbin = self.webrtcbin.clone();
        let outbound = self.outbound.clone();
        let pipeline = self.pipeline.clone();
        let promise = gst::Promise::with_change_func(move |reply| {
            let response = match reply {
                Ok(response) => response,
                Err(_) => return,
            };
            let Some(response) = response else { return; };
            let answer = match response.value("answer").ok().and_then(|value| value.get::<gst_webrtc::WebRTCSessionDescription>().ok()) {
                Some(answer) => answer,
                None => return,
            };
            webrtcbin.emit_by_name::<()>("set-local-description", &[&answer, &None::<gst::Promise>]);
            let sdp: String = match answer.sdp().as_text() {
                Ok(sdp) => sdp,
                Err(_) => return,
            };
            let _ = outbound.send(OutboundSignal { kind: SignalKind::Answer, payload: json!({ "type": "answer", "sdp": sdp }) });
            let _ = pipeline.current_state();
        });
        self.webrtcbin.emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
        Ok(())
    }

    fn handle_candidate(&self, payload: &Value) -> Result<(), MediaError> {
        let candidate = payload.get("candidate").and_then(Value::as_str).ok_or(MediaError::InvalidSignal("candidate"))?;
        let index = payload.get("sdpMLineIndex").and_then(Value::as_u64).ok_or(MediaError::InvalidSignal("candidate"))?;
        let index = u32::try_from(index).map_err(|_| MediaError::InvalidSignal("candidate"))?;
        self.webrtcbin.emit_by_name::<()>("add-ice-candidate", &[&index, &candidate]);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), MediaError> {
        self.pipeline.set_state(gst::State::Null).map_err(|error| MediaError::Pipeline(error.to_string()))?;
        Ok(())
    }
}

impl Drop for NativeWebRtcSender {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipeline_uses_only_the_portal_pipewire_fd_and_selected_node() {
        let pipeline = sender_pipeline_description(42, 917);
        assert!(pipeline.contains("pipewiresrc fd=42 path=917"));
        assert!(pipeline.contains("webrtcbin name=beamdeskwebrtc"));
        assert!(pipeline.contains("vp8enc"));
    }

    #[test]
    fn pipeline_constructs_with_the_installed_native_media_plugins() {
        gst::init().unwrap();
        let (pipeline, _) = construct_sender_pipeline(42, 917).unwrap();
        assert!(pipeline.by_name("beamdeskwebrtc").is_some());
    }

    #[test]
    fn x11_compatibility_pipeline_constructs_without_opening_a_display() {
        gst::init().unwrap();
        let (pipeline, _) = construct_x11_sender_pipeline(":99").unwrap();
        assert!(pipeline.by_name("beamdeskx11").is_some());
        assert!(pipeline.by_name("beamdeskwebrtc").is_some());
    }

    #[test]
    fn candidate_payload_matches_the_browser_webrtc_shape() {
        let payload = json!({ "candidate": "candidate:1 1 udp 1 127.0.0.1 9 typ host", "sdpMLineIndex": 0 });
        assert_eq!(payload["sdpMLineIndex"], 0);
    }
}

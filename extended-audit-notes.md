# Extended Local Audit Notes

## Browser resilience and accessibility

The locally served portal was inspected at the home and host-joined session states. It had no duplicate element identifiers, unlabeled form fields, unnamed interactive controls, or unsafe external-link targets. The operator session UI exposed a labeled chat composer and keyboard-focusable support controls after the host joined. A fresh operator session transitioned to `HOST_JOINED` through the live local API without a browser-console error. The native portal action transitioned the session to `VIEW_PENDING` without a browser-console error. An oversized 1,001-character chat submission stayed inside the current session, displayed the server-provided validation message, and caused no unhandled browser-console error.

## Linux attended-host refusal paths

The Linux host completed unit and release-build checks. It refused an unsupported desktop session, an invalid X11 display, a missing Wayland portal, and an unavailable Wayland ScreenCast service without starting capture or remote input. The command currently reports some safe refusal paths with a successful exit status; this will be corrected so automation can distinguish a cancellation or environment failure from a successful host run.

## Reproducible portal findings queued for repair

The boundary suite reproduced three portal defects: unmatched API routes returned Express HTML rather than a safe JSON error, an invalid TURN HMAC algorithm surfaced as a 500 instead of a direct-only 503 response, and repeated TURN credential reads could exceed the stated bounded audit-record limit by one event. The browser controller also needs centralized error handling for action buttons and viewer startup failures.

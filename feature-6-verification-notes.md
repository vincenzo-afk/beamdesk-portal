# Feature 6 browser verification

On 2026-08-21, the updated local BeamDesk portal rendered its consent-first homepage with cross-platform wording: it identifies the participant as the person at the host computer rather than limiting the experience to Windows.

A disposable operator session rendered the **View full audit history** and **Report a security concern and end** actions alongside the existing end-session control. Opening the audit action displayed a modal containing the authenticated session event record; the session’s `SESSION_CREATED` entry, timestamp, and actor were visible. The modal included an explicit Close control.

The functional regression suite separately verified the terminal audit endpoint, the per-IP creation cap, the report-and-end route, and the consent-gated short-lived TURN credential response.

# Debug Session: rtc-join-404

Status: [OPEN]

## Symptom
- Browser console reports: `RTC module: 通话链路建立失败 Error: 请求失败: 404`
- Stack points to `joinChannel` in `src/modules/rtc/index.js`.

## Constraints
- No business logic modification before runtime evidence is collected.
- First codebase change after this file must be instrumentation-only.

## Initial Hypotheses
- H1: Frontend calls a token/join API path that is not registered by the backend server.
- H2: Backend server is not the expected API server, or the frontend is routed through a static server without API proxy support.
- H3: Required join parameters are missing or malformed, producing a dynamic URL that points to a non-existent endpoint.
- H4: Environment/config base URL points to the wrong origin or port.
- H5: RTC token/session endpoint exists but only under a different method or route prefix.

## Evidence Log
- Pending.

## Next Step
- Locate `joinChannel` request construction and backend RTC routes, then add minimal network-report instrumentation.

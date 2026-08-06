# Ops policy

- Retry policy: every service config sets `retries` to 3.
- Gateway host is `api.internal`, port 8080.
- Feature flags currently enabled fleet-wide: `tracing`, `gzip`.

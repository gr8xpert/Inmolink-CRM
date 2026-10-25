/**
 * S12-F19: the Socket.io client for the realtime load tests in tests/perf (the perf project runs at the root, where
 * `socket.io-client` — a devDependency of this app — does not resolve). Test-only: nothing in `src` imports it.
 */
export { io, type Socket } from 'socket.io-client';

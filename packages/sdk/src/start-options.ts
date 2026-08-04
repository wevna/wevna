// The options a developer may pass to wevna.start(), and the whole set.
//
// Deliberately not @wevna/server's StartServerOptions, which start() used to
// accept wholesale. That type also carries `eventSource` and `session` —
// internal wiring Runtime supplies itself, and which a developer passing
// would silently detach the dashboard from the runtime's own event bus. They
// were never meant to be part of the public API; accepting the server's
// options type is simply how they leaked into it.
//
// Owning the shape here also keeps the published type declarations free of
// any import from @wevna/server, so the `wevna` package's types resolve
// standalone rather than requiring an internal package to be published
// alongside it.
export interface WevnaStartOptions {
  // Port for the local dashboard. Defaults to 4123. Pass 0 to let the OS
  // pick a free one — useful in tests and when several services on one
  // machine each start Wevna.
  port?: number;
  // Interface to bind to. Defaults to localhost, which is the entire point
  // of a local-first tool: the dashboard is not reachable from off the
  // machine unless a developer deliberately changes this.
  host?: string;
  // Directory to serve the dashboard's built assets from. Only useful when
  // developing Wevna itself — the published package ships its own.
  dashboardDir?: string;
}

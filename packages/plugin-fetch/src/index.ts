// @wevna/plugin-fetch: captures outgoing HTTP requests made with the global
// fetch, as http.client events correlated to the incoming request that
// triggered them.
export { createFetchPlugin, type FetchPluginOptions } from "./fetch-plugin.js";
// Exported for testing and for anyone building a similar producer: the
// redaction rules an outgoing URL goes through are worth being able to
// inspect and reuse rather than rediscover.
export { describeFetchTarget, REDACTED, sanitizeUrl } from "./sanitize-url.js";

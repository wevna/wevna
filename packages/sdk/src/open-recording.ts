import { startServer } from "@wevna/server";
import type { SessionLoaderError, SessionMetadata } from "./session-loader.js";
import { SessionLoader } from "./session-loader.js";
import type { WevnaStartOptions } from "./start-options.js";

// The same three options wevna.start() takes — see start-options.ts. Was
// Omit<StartServerOptions, "eventSource" | "session">, which subtracted the
// two internal fields but still referenced the internal package in the
// published type declarations, and would have silently re-widened Wevna's
// public API the next time a server option was added.
export type OpenRecordingOptions = WevnaStartOptions;

export interface OpenedRecording {
  url: string;
  // The header-derived snapshot as of when the recording was opened —
  // recordingEndedAt/eventCount reflect the footer only once something has
  // actually streamed through the recording (e.g. a dashboard fetching
  // /api/session/events); this won't update itself afterward. Fetch
  // /api/session again for a current view.
  metadata: SessionMetadata;
  close(): Promise<void>;
}

export type OpenRecordingResult =
  | { ok: true; recording: OpenedRecording }
  | { ok: false; error: SessionLoaderError };

// Serves an already-recorded session through the same local dashboard
// server the live path uses — @wevna/server's createServer accepts a
// `session` (OfflineSessionSource) instead of an `eventSource` for exactly
// this. No Runtime, no live instrumentation, no WebSocket route: the
// dashboard's own code doesn't need to know or care that what's feeding it
// this time is a file on disk instead of a running application.
//
// Structured, not thrown, same as SessionLoader itself — a caller (a
// future CLI, in particular) can pattern-match on `.ok` rather than
// needing a try/catch around a file that might just be the wrong shape.
export async function openRecording(
  filePath: string,
  options: OpenRecordingOptions = {},
): Promise<OpenRecordingResult> {
  const loader = new SessionLoader(filePath);
  const opened = await loader.open();
  if (!opened.ok) {
    return opened;
  }

  const server = await startServer({
    // Listed explicitly rather than spread, for the same reason
    // Runtime#performStart does: a new server option must never become part
    // of this function's public contract just by existing.
    port: options.port,
    host: options.host,
    dashboardDir: options.dashboardDir,
    session: {
      getMetadata: () => loader.metadata ?? opened.metadata,
      async *getEvents() {
        for await (const result of loader.events()) {
          if (result.ok) {
            yield result.event.envelope;
          }
          // Malformed lines are skipped here rather than surfaced to the
          // dashboard — see SessionLoader's own docs: they're already
          // recorded on loader.issues for anything that wants to inspect
          // them, without forcing the dashboard's event stream itself to
          // understand loader-specific error shapes.
        }
      },
    },
  });

  return {
    ok: true,
    recording: {
      url: server.url,
      metadata: opened.metadata,
      close: () => server.stop(),
    },
  };
}

export const USAGE = `Usage: wevna [--port <number>] [--host <name>]

Starts the Wevna dashboard and accepts events from other-language SDKs at
POST /api/ingest.

  --port   Port to listen on (default 4123; 0 picks a free one)
  --host   Interface to bind (default localhost)
`;

export function parseArgs(argv: readonly string[]): { port?: number; host?: string } | "help" {
  const options: { port?: number; host?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--port" || arg === "--host") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      index += 1;
      if (arg === "--host") {
        options.host = value;
        continue;
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port must be an integer from 0 to 65535, got "${value}"`);
      }
      options.port = port;
      continue;
    }
    throw new Error(`unknown argument "${arg}"`);
  }
  return options;
}

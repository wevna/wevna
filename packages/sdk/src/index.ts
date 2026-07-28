import { type StartedServer, type StartServerOptions, startServer } from "@wevna/server";

// TODO: Once capture (AsyncLocalStorage hooks, EventEmitter patching) exists,
// this module will also wire instrumentation up on start() and tear it down
// on stop().

let activeServer: StartedServer | undefined;
let startPromise: Promise<void> | undefined;

async function start(options?: StartServerOptions): Promise<void> {
  if (activeServer) {
    return;
  }
  if (!startPromise) {
    startPromise = performStart(options);
  }

  try {
    await startPromise;
  } finally {
    startPromise = undefined;
  }
}

async function performStart(options?: StartServerOptions): Promise<void> {
  console.log("Starting Wevna...");
  const server = await startServer(options);
  activeServer = server;
  console.log(`Wevna running at ${server.url}`);
}

async function stop(): Promise<void> {
  if (!activeServer) {
    return;
  }

  const server = activeServer;
  activeServer = undefined;

  console.log("Stopping Wevna...");
  await server.stop();
  console.log("Wevna stopped.");
}

// A single shared instance is intentional: Wevna mirrors tools like Prisma
// Studio and Storybook, where one local dev server is started per process.
export const wevna = {
  start,
  stop,
};

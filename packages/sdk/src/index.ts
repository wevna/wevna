import type { StartServerOptions } from "@wevna/server";
import { Runtime } from "./runtime.js";

// TODO: Once capture (AsyncLocalStorage hooks, EventEmitter patching) exists,
// it will be wired up as another subsystem inside Runtime, not here.

// A single shared Runtime instance is intentional: Wevna mirrors tools like
// Prisma Studio and Storybook, where one local dev server is started per
// process. The SDK is just a thin public-facing wrapper — Runtime owns the
// actual lifecycle.
const runtime = new Runtime();

export const wevna = {
  start(options?: StartServerOptions): Promise<void> {
    return runtime.start(options);
  },
  stop(): Promise<void> {
    return runtime.stop();
  },
};

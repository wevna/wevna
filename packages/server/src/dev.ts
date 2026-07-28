import { startServer } from "./start.js";

async function main(): Promise<void> {
  const server = await startServer();
  console.log(`Wevna server listening at ${server.url}`);

  const shutdown = async (): Promise<void> => {
    console.log("Stopping Wevna server...");
    await server.stop();
    console.log("Wevna server stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

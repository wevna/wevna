import { buildServer } from "./server.js";

const DEFAULT_PORT = 4123;

const app = buildServer();

app
  .listen({ port: DEFAULT_PORT })
  .then(() => {
    app.log.info(`Wevna server listening at http://localhost:${DEFAULT_PORT}`);
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });

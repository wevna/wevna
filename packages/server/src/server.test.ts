import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDashboardDir = path.join(currentDir, "__fixtures__/dashboard");
const missingDashboardDir = path.join(currentDir, "__fixtures__/does-not-exist");

describe("createServer", () => {
  it("responds to GET /health with a running status payload", async () => {
    const app = createServer();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "running", product: "wevna" });
  });

  it("serves the dashboard's index.html at the root", async () => {
    const app = createServer({ dashboardDir: fixtureDashboardDir });

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("fixture dashboard");
  });

  it("still serves /health when the dashboard has not been built", async () => {
    const app = createServer({ dashboardDir: missingDashboardDir });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
  });
});

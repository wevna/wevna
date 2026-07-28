import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("buildServer", () => {
  it("responds to GET / with 'Wevna Server'", async () => {
    const app = buildServer();

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("Wevna Server");
  });
});

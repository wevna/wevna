import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: false,
  clean: true,
  sourcemap: true,
  // @wevna/server is a private workspace-only package (never published), so
  // its compiled output must be inlined into the published "wevna" bundle.
  // fastify stays external and is declared as a real dependency instead.
  noExternal: ["@wevna/server"],
});

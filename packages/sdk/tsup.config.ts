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
  esbuildOptions(options) {
    // The inlined dashboard path resolution checks `typeof __dirname` before
    // falling back to `import.meta.url`; in the cjs build __dirname always
    // wins, so the import.meta branch is genuinely dead code there. Silence
    // esbuild's static (and here, inapplicable) warning about it.
    options.logOverride = { ...options.logOverride, "empty-import-meta": "silent" };
  },
});

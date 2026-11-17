import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The standalone buy alert bundle (`dist/buys.js`, IIFE global `GullyBuys`; `dist/buys.mjs`, ESM).
 *
 * Like `gullycore-embed.js`, nothing is external: a site pastes one script tag and
 * gets viem's log reader, the MIT SDK's market reader and the address book with it.
 * No React, no wallet code. Runs after the library build, so it must not empty `dist`.
 * The hosted copy at https://gullycore.xyz/buys.js is this file, byte for byte.
 */
export default defineConfig({
  resolve: { dedupe: ["viem"] },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    target: "es2022",
    minify: "esbuild",
    lib: {
      entry: resolve(__dirname, "src/gully-buys.ts"),
      name: "GullyBuys",
      formats: ["iife", "es"],
      fileName: (format) => (format === "iife" ? "buys.js" : "buys.mjs"),
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});

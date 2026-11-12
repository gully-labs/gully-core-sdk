import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The standalone embed bundle (`dist/gullycore-embed.js`, IIFE; `dist/gullycore-embed.mjs`, ESM).
 *
 * Unlike the library build nothing is external: a project site drops in one
 * script tag and gets viem, the MIT SDK's readers and the address book with
 * it. There is no React in it - `<gullycore-lock-badge>` renders plain DOM - and
 * no wallet code. Runs after the library build, so it must not empty `dist`.
 */
export default defineConfig({
  /* The SDK is linked with its own node_modules: one viem, not two. */
  resolve: { dedupe: ["viem"] },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    target: "es2020",
    minify: "esbuild",
    lib: {
      entry: resolve(__dirname, "src/gullycore-embed.ts"),
      name: "GullyCoreEmbed",
      formats: ["iife", "es"],
      fileName: (format) => (format === "iife" ? "gullycore-embed.js" : "gullycore-embed.mjs"),
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});

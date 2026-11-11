// SPDX-License-Identifier: MIT
/* dist/cjs holds the CommonJS build (tsconfig.cjs.json). This marker makes Node and TypeScript read the .js and
   .d.ts files there as CommonJS, so `require("@gullylabs/core-sdk")` gets CommonJS code and CommonJS types. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cjs");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");

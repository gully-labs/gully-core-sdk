#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/** `node packages/create-gully-core-app/dist/bin/create-app.js <directory>` from a checkout; `npm create @gullylabs/core-app <directory>` / `npx @gullylabs/create-core-app <directory>` once the package is on npm. */

import { runCreate } from "../commands/create.js";
import { reportFatal } from "../util/log.js";

runCreate(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.exitCode = reportFatal(err);
  },
);

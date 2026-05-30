import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Package version — also used as session JSON `version` field. */
export const VERSION: string = require("../package.json").version;

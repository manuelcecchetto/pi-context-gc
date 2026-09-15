// Explicit alias for loading only the semantic scheduler when another
// `session_before_compact` backend is already installed.
export { default } from "./src/extension.ts";
export { createContextGcExtension } from "./src/extension.ts";

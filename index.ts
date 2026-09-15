// Scheduler entrypoint. The package manifest loads the bundled native OpenAI
// compaction backend before this file. Loading this file directly runs only the
// semantic scheduler; that is useful when another backend already owns
// `session_before_compact`.
export { default } from "./src/extension.ts";
export { createContextGcExtension } from "./src/extension.ts";

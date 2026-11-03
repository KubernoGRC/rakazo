import { serve } from "@hono/node-server";
import { createModelRelayApp } from "./model-relay.js";
import { modelRelayConfigFromEnv } from "./model-relay-logic.js";

// Fork patch: the model relay's entry point (docs/fork-computer-model-relay.md).
// Started as its own container: `tsx src/model-relay-main.ts`.
const config = modelRelayConfigFromEnv();
serve({ fetch: createModelRelayApp({ config }).fetch, hostname: config.host, port: config.port });
process.stdout.write(
  `${JSON.stringify({ event: "model.relay.started", port: config.port, models: config.models })}\n`,
);

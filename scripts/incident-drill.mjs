#!/usr/bin/env node

/**
 * CLI wrapper for running the Mimir incident drill.
 *
 * Runs credential-free simulations of long-running Stellar and Telegram failures.
 */

import { runIncidentDrillCli } from "../dist/drill.js";

runIncidentDrillCli().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

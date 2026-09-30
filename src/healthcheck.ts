/**
 * Container healthcheck script.
 * 
 * Designed to be run periodically by a container supervisor (like Docker HEALTHCHECK or K8s liveness/readiness probes).
 * It reads the same HEALTH_HOST and HEALTH_PORT environment variables used by the main process
 * and issues an HTTP GET to /health.
 * 
 * Exits 0 if the health endpoint returns HTTP 200.
 * Exits 1 otherwise.
 */

import http from "node:http";

function main() {
  const host = process.env.HEALTH_HOST || "127.0.0.1";
  const portRaw = process.env.HEALTH_PORT;
  const port = portRaw !== undefined ? parseInt(portRaw, 10) : 8787;

  if (Number.isNaN(port) || port === 0) {
    console.log("[healthcheck] Disabled (HEALTH_PORT=0 or invalid)");
    process.exit(0);
  }

  const req = http.request(
    {
      host,
      port,
      path: "/health",
      method: "GET",
      timeout: 2000,
    },
    (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("[healthcheck] OK");
          process.exit(0);
        } else {
          console.error(`[healthcheck] Failed: HTTP ${res.statusCode} - ${body.trim()}`);
          process.exit(1);
        }
      });
    }
  );

  req.on("error", (err) => {
    console.error(`[healthcheck] Request failed: ${err.message}`);
    process.exit(1);
  });

  req.on("timeout", () => {
    req.destroy();
    console.error("[healthcheck] Request timed out");
    process.exit(1);
  });

  req.end();
}

main();

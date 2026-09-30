import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";

const execFileAsync = promisify(execFile);

// Helper to spawn a mock server that answers /health
async function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

test("healthcheck exits 0 on HTTP 200", async () => {
  const server = await startMockServer((req, res) => {
    assert.equal(req.url, "/health");
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
  });

  const { port } = server.address();
  
  try {
    const { stdout, stderr } = await execFileAsync("node", ["dist/healthcheck.js"], {
      env: { ...process.env, HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(port) },
    });
    assert.match(stdout, /\[healthcheck\] OK/);
  } finally {
    server.close();
  }
});

test("healthcheck exits 1 on HTTP 503", async () => {
  const server = await startMockServer((req, res) => {
    res.writeHead(503);
    res.end(JSON.stringify({ status: "degraded" }));
  });

  const { port } = server.address();
  
  try {
    await execFileAsync("node", ["dist/healthcheck.js"], {
      env: { ...process.env, HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(port) },
    });
    assert.fail("Should have thrown on non-zero exit");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /\[healthcheck\] Failed: HTTP 503/);
  } finally {
    server.close();
  }
});

test("healthcheck exits 1 on connection refused", async () => {
  // Use a port that is highly likely to be closed
  const port = 34567;
  try {
    await execFileAsync("node", ["dist/healthcheck.js"], {
      env: { ...process.env, HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(port) },
    });
    assert.fail("Should have thrown on non-zero exit");
  } catch (err) {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /\[healthcheck\] Request failed/);
  }
});

test("healthcheck exits 0 when disabled via HEALTH_PORT=0", async () => {
  const { stdout } = await execFileAsync("node", ["dist/healthcheck.js"], {
    env: { ...process.env, HEALTH_PORT: "0" },
  });
  assert.match(stdout, /Disabled/);
});

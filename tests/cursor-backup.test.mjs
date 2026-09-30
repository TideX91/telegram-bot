import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { backupCursor, restoreCursor } from "../dist/cursor-cli.js";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-backup-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("backup preserves a validated cursor and refuses overwrite by default", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const raw = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "opaque-cursor", lastEventLedger: 42 } },
    }, null, 2)}\n`;
    await writeFile(cursorFile, raw);

    await backupCursor({ cursorFile, backupFile });
    assert.equal(await readFile(backupFile, "utf8"), raw);
    await assert.rejects(backupCursor({ cursorFile, backupFile }), /already exists/);
  });
});

test("malformed cursor backup is rejected without creating a destination", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    await writeFile(cursorFile, "{not json");

    await assert.rejects(backupCursor({ cursorFile, backupFile }), /malformed|unsupported/);
    assert.equal(await exists(backupFile), false);
  });
});

test("restore requires force and atomically writes a compatible cursor under lock", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const lockFile = path.join(directory, "poller.lock");
    const original = JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "restored-cursor", lastEventLedger: 42 } },
    });
    await writeFile(backupFile, original);
    await writeFile(cursorFile, "existing cursor");

    await assert.rejects(
      restoreCursor({ cursorFile, backupFile, lockFile }),
      /pass --force/,
    );
    assert.equal(await readFile(cursorFile, "utf8"), "existing cursor");

    await restoreCursor({ cursorFile, backupFile, lockFile, force: true });
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.version, 1);
    assert.equal(restored.targets.market.cursor, "restored-cursor");
    assert.equal(restored.targets.market.lastEventLedger, 42);
    assert.equal(await exists(lockFile), false);
  });
});

test("restore normalizes supported legacy cursor files to version 1", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "legacy.json");
    const lockFile = path.join(directory, "poller.lock");
    await writeFile(backupFile, JSON.stringify({ market: "legacy-cursor" }));

    await restoreCursor({ cursorFile, backupFile, lockFile });
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.version, 1);
    assert.equal(restored.targets.market.cursor, "legacy-cursor");
    assert.equal(restored.targets.market.lastEventLedger, null);
  });
});
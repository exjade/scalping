import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BotDataReader } from "../server/bot-data-reader.js";

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for a local file update");
};

test("reader reports missing state, preserves last valid JSON and streams completed JSONL rows", async (t) => {
  const originalCwd = process.cwd();
  const previousDataDir = process.env.BOT_DATA_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), "pearl-reader-"));
  t.after(async () => {
    process.chdir(originalCwd);
    if (previousDataDir === undefined) delete process.env.BOT_DATA_DIR;
    else process.env.BOT_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  });
  process.chdir(directory);
  process.env.BOT_DATA_DIR = directory;
  const reader = new BotDataReader();
  t.after(() => reader.stop());
  await reader.start();

  assert.equal(reader.current().mode, "live");
  assert.equal(reader.current().state, null);
  assert.equal(reader.current().files.state.exists, false);

  const stateFile = path.join(directory, "state.json");
  await writeFile(stateFile, JSON.stringify({ version: "5.1.8", cash: 100 }), "utf8");
  await waitFor(() => reader.current().state?.version === "5.1.8");
  await writeFile(stateFile, "{\"version\":", "utf8");
  await waitFor(() => (reader.current().files.state.parseErrors ?? 0) > 0);
  assert.equal(reader.current().state?.cash, 100);

  const eventsFile = path.join(directory, "events.jsonl");
  await writeFile(eventsFile, "{\"type\":\"LOCK ACTIVATED\"", "utf8");
  await waitFor(() => reader.current().files.events.partialLine);
  assert.equal(reader.current().events.length, 0);
  await appendFile(eventsFile, ",\"triggerPrice\":1.8}\n", "utf8");
  await waitFor(() => reader.current().events.length === 1);
  assert.equal(reader.current().events[0].type, "LOCK ACTIVATED");
  assert.equal(await readFile(eventsFile, "utf8"), "{\"type\":\"LOCK ACTIVATED\",\"triggerPrice\":1.8}\n");
  assert.equal(await readFile(stateFile, "utf8"), "{\"version\":");
});

test("reader selects bundled fixtures and marks them as demo when no data directory is configured", async (t) => {
  const originalCwd = process.cwd();
  const previousDataDir = process.env.BOT_DATA_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), "pearl-demo-"));
  const fixtureDirectory = path.resolve(originalCwd, "fixtures");
  t.after(async () => {
    process.chdir(originalCwd);
    if (previousDataDir === undefined) delete process.env.BOT_DATA_DIR;
    else process.env.BOT_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, "fixtures"));
  for (const file of ["state.json", "events.jsonl", "paper_trades.jsonl", "signals.jsonl", "summary_24h.json"]) {
    await copyFile(path.join(fixtureDirectory, file), path.join(directory, "fixtures", file));
  }
  process.chdir(directory);
  delete process.env.BOT_DATA_DIR;
  const reader = new BotDataReader();
  t.after(() => reader.stop());
  await reader.start();
  assert.equal(reader.current().mode, "demo");
  assert.equal(reader.current().dataDirectoryConfigured, false);
  assert.equal(reader.current().state?.version, "5.1.8");
  assert.equal(reader.current().trades.length, 3);
});

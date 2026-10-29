import assert from "node:assert/strict";
import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonlTail } from "../server/jsonl-tail.js";

test("JSONL tail holds a partial final record until its newline arrives", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pearl-tail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "events.jsonl");
  await writeFile(file, "{\"type\":\"READY\"", "utf8");
  const tail = new JsonlTail(file);

  const partial = await tail.refresh();
  assert.equal(partial.records.length, 0);
  assert.equal(partial.file.partialLine, true);

  await appendFile(file, ",\"version\":\"5.1.8\"}\n", "utf8");
  const complete = await tail.refresh();
  assert.equal(complete.records.length, 1);
  assert.equal(complete.records[0].type, "READY");
  assert.equal(complete.file.partialLine, false);
  assert.equal(complete.file.parseErrors, 0);
});

test("JSONL tail resets after truncation and follows the new file contents", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pearl-truncate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "trades.jsonl");
  await writeFile(file, "{\"type\":\"OLD\"}\n", "utf8");
  const tail = new JsonlTail(file);
  assert.equal((await tail.refresh()).records[0].type, "OLD");
  await new Promise((resolve) => setTimeout(resolve, 15));
  await writeFile(file, "{\"type\":\"NEW\"}\n", "utf8");
  const refreshed = await tail.refresh();
  assert.equal(refreshed.records.length, 1);
  assert.equal(refreshed.records[0].type, "NEW");
});

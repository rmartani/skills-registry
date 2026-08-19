import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildIndex, serializeIndex } from "../../src/index/build-index.js";

test("index generation is byte-identical when manifests do not change", async () => {
  const rootDir = path.resolve(process.cwd());
  const first = serializeIndex(await buildIndex(rootDir));
  const second = serializeIndex(await buildIndex(rootDir));
  assert.equal(second, first);
  assert.equal(first, (await readFile(path.join(rootDir, "registry/index.json"))).toString("utf8"));
});

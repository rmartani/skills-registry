import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const workflowPath = path.resolve(process.cwd(), ".github/workflows/daily-sync.yml");

test("manual resource sync requires canonical IDs and does not collide with daily all", async () => {
  const content = (await readFile(workflowPath)).toString("utf8");

  assert.match(content, /resource_ids:\n\s+description: .*scope=resources/);
  assert.match(content, /DISPATCH_RESOURCE_IDS: \$\{\{ inputs\.resource_ids \}\}/);
  assert.match(content, /scope resources exige resource_ids/);
  assert.match(content, /scope resources só pode ser usado por workflow_dispatch/);
  assert.match(content, /test\("\^\[0-9a-f\]\{8\}/);
  assert.match(content, /resource_ids não pode conter duplicatas/);
  assert.match(content, /--argjson resourceIds "\$resource_ids_json"/);
  assert.match(content, /resource_ids_json='\[\]'/);
  assert.match(content, /idempotency_key="daily-\$\(date -u \+%F\)"/);
  assert.match(content, /idempotency_key="\$\{idempotency_key\}-resources-\$\{resource_digest:0:16\}"/);
});

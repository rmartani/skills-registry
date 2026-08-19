import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const rootDir = path.resolve(process.cwd());

async function workflow(name: string): Promise<string> {
  return (await readFile(path.join(rootDir, ".github/workflows", name))).toString("utf8");
}

test("validation workflow regenerates index before checking staged publication PRs", async () => {
  const content = await workflow("validate.yml");
  assert.ok(content.indexOf("Rebuild generated index before validation") < content.indexOf("Validate schemas and references"));
  assert.match(content, /REGISTRY_ALLOW_STAGED:.*startsWith\(github\.head_ref, 'registry\/publication\/'\).*vars\.ENABLE_REGISTRY_PUBLISH == 'true'/);
  assert.match(content, /packaging\.mode == "staged"/);
  assert.match(content, /Reject staged versions outside the gated publication handoff/);
  assert.match(content, /packaging\.mode=staged is accepted only on a backend-generated registry\/publication\/\* PR when ENABLE_REGISTRY_PUBLISH=true/);
  assert.match(content, /Main validation and reconcile reject staged metadata/);
  assert.match(content, /if \[ -n "\$staged_id" \] && \[ "\$ALLOW_STAGED" = "true" \]/);
  assert.match(content, /Index drift is deferred only to the gated post-merge staged packaging handoff/);
  assert.match(content, /PUBLICATION_PR:.*startsWith\(github\.head_ref, 'registry\/publication\/'\).*vars\.ENABLE_REGISTRY_PUBLISH == 'true'/);
  assert.match(content, /package:dry-run -- --live --allow-staged/);
  assert.doesNotMatch(content, /if \{ \[ "\$PUBLICATION_PR" = "true" \] \|\| \{ \[ "\$EVENT_NAME" = "push" \]/);
});

test("publication workflow converts staged state before release and reconciles final commit", async () => {
  const content = await workflow("publish.yml");
  const inputValidation = content.indexOf("Validate publication input");
  const handoff = content.indexOf("Convert explicit staged versions after merge");
  const convertedValidation = content.indexOf("Validate converted canonical state");
  const postConversionIndexCheck = content.indexOf("git diff --exit-code -- registry/index.json", handoff);

  assert.ok(inputValidation >= 0);
  assert.ok(handoff > inputValidation);
  assert.ok(convertedValidation > handoff);
  assert.ok(postConversionIndexCheck < 0, "converted index must not be compared with the pre-handoff HEAD");
  assert.match(content, /git diff --exit-code -- registry\/index\.json/);
  assert.match(content, /package:prepare -- --output \.generated\/staged-packages/);
  assert.match(content, /REGISTRY_ALLOW_STAGED: "false"/);
  assert.match(content, /allowed='\^\(registry\/index\\.json\|registry\/projects/);
  assert.match(content, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(content, /\[skip registry publish\]/);
  assert.match(content, /sha256sum --check --status/);
  assert.match(content, /cmp -s - "\$artifact\.sha256"/);
  assert.match(content, /--arg sha "\$PUBLISH_SHA" '\{commitSha:\$sha\}'/);
  assert.match(content, /PUBLISH_SHA: \$\{\{ steps\.handoff\.outputs\.publish_sha \}\}/);
});

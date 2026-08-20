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
  assert.match(content, /REGISTRY_ALLOW_STAGED:.*github\.event_name == 'pull_request'.*github\.event\.pull_request\.head\.repo\.full_name == github\.repository.*startsWith\(github\.head_ref, 'registry\/publication\/'\).*vars\.ENABLE_REGISTRY_PUBLISH == 'true'/);
  assert.doesNotMatch(content, /github\.event_name == 'push'.*ENABLE_REGISTRY_PUBLISH/);
  assert.match(content, /packaging\.mode == "staged"/);
  assert.match(content, /Reject staged versions outside the gated publication handoff/);
  assert.match(content, /packaging\.mode=staged is accepted only on a backend-generated registry\/publication\/\* PR when ENABLE_REGISTRY_PUBLISH=true/);
  assert.match(content, /Main validation and reconcile reject staged metadata/);
  assert.match(content, /if \[ -n "\$staged_id" \] && \[ "\$ALLOW_STAGED" = "true" \] && \[ "\$PUBLICATION_PR" = "true" \]/);
  assert.match(content, /Index drift is deferred only to the gated staged publication PR/);
  assert.match(content, /PUBLICATION_PR:.*github\.event\.pull_request\.head\.repo\.full_name == github\.repository.*startsWith\(github\.head_ref, 'registry\/publication\/'\).*vars\.ENABLE_REGISTRY_PUBLISH == 'true'/);
  assert.match(content, /package:dry-run -- --live --allow-staged/);
  assert.doesNotMatch(content, /\$EVENT_NAME/);
});

test("staged publication hands off to one deterministic human-reviewed PR", async () => {
  const content = await workflow("publish.yml");
  const inputValidation = content.indexOf("Validate publication input");
  const stagedDetection = content.indexOf("Detect staged publication handoff");
  const handoff = content.indexOf("Create or update staged publication PR");
  const convertedValidation = content.indexOf("Validate converted canonical state");
  const releases = content.indexOf("Create or update verified resource releases");
  const reconcile = content.indexOf("Reconcile verified main commit in API");
  const postHandoffIndexCheck = content.indexOf("git diff --exit-code -- registry/index.json", handoff);

  assert.ok(inputValidation >= 0);
  assert.ok(stagedDetection >= 0);
  assert.ok(stagedDetection < inputValidation);
  assert.ok(handoff > stagedDetection);
  assert.ok(convertedValidation > stagedDetection);
  assert.ok(releases > handoff);
  assert.ok(reconcile > releases);
  assert.equal(postHandoffIndexCheck, -1, "converted index must not be compared with the pre-handoff HEAD");
  assert.match(content, /git diff --exit-code -- registry\/index\.json/);
  assert.match(content, /package:prepare -- --output \.generated\/staged-packages/);
  assert.match(content, /REGISTRY_ALLOW_STAGED: "false"/);
  assert.match(content, /HAS_STAGED: \$\{\{ steps\.staged\.outputs\.has_staged \}\}/);
  assert.match(content, /permissions:\n  contents: write\n  pull-requests: write/);
  assert.match(content, /handoff_branch="registry\/publication\/\$staged_digest"/);
  assert.match(content, /git switch --create "\$HANDOFF_BRANCH" main/);
  assert.match(content, /git push --set-upstream origin "\$HANDOFF_BRANCH"/);
  assert.match(content, /gh pr list --state open --base main --head "\$HANDOFF_BRANCH"/);
  assert.match(content, /gh pr create --base main --head "\$HANDOFF_BRANCH"/);
  assert.match(content, /A human review and merge of this PR into main is mandatory/);
  assert.doesNotMatch(content, /git push origin HEAD:main/);
  assert.doesNotMatch(content, /git push --force/);
  assert.doesNotMatch(content, /\[skip registry publish\]/);
  assert.match(content, /allowed='\^\(registry\/index\\\.json\|registry\/projects/);
  assert.match(content, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(content, /sha256sum --check --status/);
  assert.match(content, /cmp -s - "\$artifact\.sha256"/);
  assert.match(content, /--arg sha "\$PUBLISH_SHA" '\{commitSha:\$sha\}'/);
  assert.match(content, /PUBLISH_SHA: \$\{\{ steps\.publish\.outputs\.publish_sha \}\}/);

  const canonicalCondition = "if: steps.staged.outputs.has_staged == 'false'";
  assert.ok(content.indexOf(canonicalCondition, releases - 100) >= 0, "releases require non-staged state");
  assert.ok(content.indexOf(canonicalCondition, reconcile - 100) >= 0, "reconcile requires non-staged state");
});

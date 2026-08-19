import assert from "node:assert/strict";
import { test } from "node:test";
import { isCandidateAllowed } from "../../src/detection/version-detector.js";

test("candidate policy excludes experimental and non-promoted paths", () => {
  assert.equal(isCandidateAllowed("engineering/tdd/SKILL.md", false, "promoted"), true);
  assert.equal(isCandidateAllowed("productivity/grill/SKILL.md", false, "promoted"), true);
  assert.equal(isCandidateAllowed("misc/tool/SKILL.md", false, "promoted"), false);
  assert.equal(isCandidateAllowed("engineering/experimental/SKILL.md", false, "promoted"), false);
  assert.equal(isCandidateAllowed("engineering/experimental/SKILL.md", true, "promoted"), true);
  assert.equal(isCandidateAllowed("skills/SKILL.md", false, "opt-in"), false);
  assert.equal(isCandidateAllowed("skills/SKILL.md", true, "opt-in"), true);
});

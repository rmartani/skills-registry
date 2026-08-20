import assert from "node:assert/strict";
import { test } from "node:test";
import { changedTreePaths, entriesWithinPath, hashTreeEntries } from "../../src/detection/path-hash.js";

test("path hash is sorted, scoped and unaffected by unrelated files", () => {
  const entries = [
    { path: "README.md", sha: "readme", mode: "100644", type: "blob" as const },
    { path: "skills/b/SKILL.md", sha: "b", mode: "100644", type: "blob" as const },
    { path: "skills/a/SKILL.md", sha: "a", mode: "100644", type: "blob" as const }
  ];
  const shuffled = [entries[2]!, entries[0]!, entries[1]!];
  assert.equal(hashTreeEntries(entries, "skills"), hashTreeEntries(shuffled, "skills"));
  assert.deepEqual(changedTreePaths(entries, [{ ...entries[0]!, sha: "new-readme" }, ...entries.slice(1)], "skills"), []);
  assert.deepEqual(changedTreePaths(entries, [{ ...entries[0]!, sha: "new-readme" }, { ...entries[1]!, sha: "new-b" }, entries[2]!], "skills"), ["b/SKILL.md"]);
});

test("exact monitored files use a stable basename and detect changes", () => {
  const before = [
    { path: "README.md", sha: "readme", mode: "100644", type: "blob" as const },
    { path: "skills/brainstorming/SKILL.md", sha: "old", mode: "100644", type: "blob" as const }
  ];
  const after = before.map((entry) => entry.path === "skills/brainstorming/SKILL.md" ? { ...entry, sha: "new" } : entry);

  assert.deepEqual(entriesWithinPath(before, "skills/brainstorming/SKILL.md").map((entry) => entry.path), ["SKILL.md"]);
  assert.notEqual(hashTreeEntries(before, "skills/brainstorming/SKILL.md"), hashTreeEntries(after, "skills/brainstorming/SKILL.md"));
  assert.deepEqual(changedTreePaths(before, after, "skills/brainstorming/SKILL.md"), ["SKILL.md"]);
  assert.deepEqual(changedTreePaths(before, [{ ...before[0]!, sha: "new-readme" }, before[1]!], "skills/brainstorming/SKILL.md"), []);
});

test("root monitored path has a stable hash", () => {
  const entries = [{ path: "LICENSE", sha: "license", mode: "100644", type: "blob" as const }];
  assert.match(hashTreeEntries(entries, "."), /^[a-f0-9]{64}$/);
});

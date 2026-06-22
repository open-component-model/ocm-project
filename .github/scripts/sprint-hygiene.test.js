import assert from "assert";
import {
  assertAllowedProjectNumber,
  DEFAULT_ALLOWED_PROJECT_NUMBER,
  findNextSprint,
  isBacklogHygieneStatus,
  isNeedsRefinementStatus,
  isTerminalStatus,
  projectFieldQueryToken,
} from "./sprint-hygiene.js";

// ----------------------------------------------------------
// findNextSprint tests
// ----------------------------------------------------------
console.log("Testing findNextSprint...");

// Returns the next sprint after the current sprint
{
  const iterations = [
    { id: "s1", title: "Sprint 1", startDate: "2026-04-07", duration: 14 },
    { id: "s2", title: "Sprint 2", startDate: "2026-04-21", duration: 14 },
    { id: "s3", title: "Sprint 3", startDate: "2026-05-05", duration: 14 },
  ];
  const result = findNextSprint(iterations, "2026-04-25");
  assert.strictEqual(result.id, "s3", "should pick Sprint 3 as the next sprint");
}

// Returns the sprint after today's starting sprint
{
  const iterations = [
    { id: "s1", title: "Sprint 1", startDate: "2026-04-07", duration: 14 },
    { id: "s2", title: "Sprint 2", startDate: "2026-04-21", duration: 14 },
    { id: "s3", title: "Sprint 3", startDate: "2026-05-05", duration: 14 },
  ];
  const result = findNextSprint(iterations, "2026-04-21");
  assert.strictEqual(result.id, "s3", "should pick the sprint after the one starting today");
}

// Falls back to nearest upcoming sprint when today is before all iterations
{
  const iterations = [
    { id: "s1", title: "Sprint 1", startDate: "2026-05-01", duration: 14 },
    { id: "s2", title: "Sprint 2", startDate: "2026-05-15", duration: 14 },
  ];
  const result = findNextSprint(iterations, "2026-04-25");
  assert.strictEqual(result.id, "s1", "should pick the nearest upcoming sprint");
}

// Returns null when no upcoming sprint exists
{
  const iterations = [
    { id: "s1", title: "Sprint 1", startDate: "2026-03-01", duration: 14 },
    { id: "s2", title: "Sprint 2", startDate: "2026-03-15", duration: 14 },
  ];
  const result = findNextSprint(iterations, "2026-04-25");
  assert.strictEqual(result, null, "should return null when no upcoming sprint exists");
}

console.log("  findNextSprint: all passed");

// ----------------------------------------------------------
// isBacklogHygieneStatus tests
// ----------------------------------------------------------
console.log("Testing isBacklogHygieneStatus...");

assert.strictEqual(isBacklogHygieneStatus(undefined), true, "empty status is eligible");
assert.strictEqual(isBacklogHygieneStatus("Needs Refinement"), true, "Needs Refinement is eligible");
assert.strictEqual(isBacklogHygieneStatus("🛠️ Needs Refinement"), true, "emoji-prefixed Needs Refinement is eligible");
assert.strictEqual(isBacklogHygieneStatus("TODO"), true, "TODO is eligible");
assert.strictEqual(isBacklogHygieneStatus("🆕 ToDo"), true, "emoji-prefixed ToDo is eligible");
assert.strictEqual(isBacklogHygieneStatus("In Progress"), false, "In Progress is not eligible");
assert.strictEqual(isBacklogHygieneStatus("In Review"), false, "In Review is not eligible");

console.log("  isBacklogHygieneStatus: all passed");

// ----------------------------------------------------------
// isTerminalStatus tests
// ----------------------------------------------------------
console.log("Testing isTerminalStatus...");

assert.strictEqual(isTerminalStatus("Done"), true, "Done is terminal");
assert.strictEqual(isTerminalStatus("🍺 Done"), true, "emoji-prefixed Done is terminal");
assert.strictEqual(isTerminalStatus("Closed"), true, "Closed is terminal");
assert.strictEqual(isTerminalStatus("🔒Closed"), true, "emoji-prefixed Closed is terminal");
assert.strictEqual(isTerminalStatus("In Progress"), false, "In Progress is not terminal");
assert.strictEqual(isTerminalStatus("Review"), false, "Review is not terminal");

console.log("  isTerminalStatus: all passed");

// ----------------------------------------------------------
// isNeedsRefinementStatus tests
// ----------------------------------------------------------
console.log("Testing isNeedsRefinementStatus...");

assert.strictEqual(isNeedsRefinementStatus("Needs Refinement"), true, "Needs Refinement is matched");
assert.strictEqual(isNeedsRefinementStatus("🛠️ Needs Refinement"), true, "emoji-prefixed Needs Refinement is matched");
assert.strictEqual(isNeedsRefinementStatus("Next-UP"), false, "Next-UP is not Needs Refinement");
assert.strictEqual(isNeedsRefinementStatus("📋 Next-UP"), false, "emoji-prefixed Next-UP is not Needs Refinement");

console.log("  isNeedsRefinementStatus: all passed");

// ----------------------------------------------------------
// assertAllowedProjectNumber tests
// ----------------------------------------------------------
console.log("Testing assertAllowedProjectNumber...");

assert.doesNotThrow(
  () => assertAllowedProjectNumber(DEFAULT_ALLOWED_PROJECT_NUMBER, DEFAULT_ALLOWED_PROJECT_NUMBER),
  "matching project number should be allowed",
);
assert.doesNotThrow(
  () => assertAllowedProjectNumber(123, undefined),
  "missing allowed project number should disable the guard",
);
assert.throws(
  () => assertAllowedProjectNumber(123, DEFAULT_ALLOWED_PROJECT_NUMBER),
  /unexpected project/,
  "mismatched project number should be rejected",
);

console.log("  assertAllowedProjectNumber: all passed");

// ----------------------------------------------------------
// projectFieldQueryToken tests
// ----------------------------------------------------------
console.log("Testing projectFieldQueryToken...");

assert.strictEqual(
  projectFieldQueryToken("Story Points (Number)"),
  "story-points-(number)",
  "field display name should become the Projects search token",
);
assert.strictEqual(
  projectFieldQueryToken("Story Points"),
  "story-points",
  "fallback field name should become the Projects search token",
);

console.log("  projectFieldQueryToken: all passed");

console.log("\nAll sprint-hygiene tests passed.");

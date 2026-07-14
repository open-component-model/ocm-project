import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedProjectNumber,
  buildRules,
  DEFAULT_ALLOWED_PROJECT_NUMBER,
  findCurrentSprint,
  findNextSprint,
  isBacklogHygieneStatus,
  isNeedsRefinementStatus,
  isTerminalStatus,
  parseIteration,
  projectFieldQueryToken,
} from "./sprint-hygiene.js";

// The helpers work on Date-based iterations; parse ISO fixtures the same way
// the production code does at the GraphQL boundary. `d` builds a UTC-midnight
// Date from an ISO date string, matching how `today` is compared.
const iters = (...rows) => rows.map(parseIteration);
const d = (isoDate) => new Date(isoDate);

describe("findNextSprint", () => {
  test("returns the next sprint after the current sprint", () => {
    const iterations = iters(
      { id: "s1", title: "Sprint 1", startDate: "2026-04-07", duration: 14 },
      { id: "s2", title: "Sprint 2", startDate: "2026-04-21", duration: 14 },
      { id: "s3", title: "Sprint 3", startDate: "2026-05-05", duration: 14 },
    );
    assert.equal(findNextSprint(iterations, d("2026-04-25")).id, "s3");
  });

  test("returns the sprint after today's starting sprint", () => {
    const iterations = iters(
      { id: "s1", title: "Sprint 1", startDate: "2026-04-07", duration: 14 },
      { id: "s2", title: "Sprint 2", startDate: "2026-04-21", duration: 14 },
      { id: "s3", title: "Sprint 3", startDate: "2026-05-05", duration: 14 },
    );
    assert.equal(findNextSprint(iterations, d("2026-04-21")).id, "s3");
  });

  test("falls back to nearest upcoming sprint when today is before all iterations", () => {
    const iterations = iters(
      { id: "s1", title: "Sprint 1", startDate: "2026-05-01", duration: 14 },
      { id: "s2", title: "Sprint 2", startDate: "2026-05-15", duration: 14 },
    );
    assert.equal(findNextSprint(iterations, d("2026-04-25")).id, "s1");
  });

  test("returns null when no upcoming sprint exists", () => {
    const iterations = iters(
      { id: "s1", title: "Sprint 1", startDate: "2026-03-01", duration: 14 },
      { id: "s2", title: "Sprint 2", startDate: "2026-03-15", duration: 14 },
    );
    assert.equal(findNextSprint(iterations, d("2026-04-25")), null);
  });
});

describe("findCurrentSprint", () => {
  const iterations = iters(
    { id: "s1", title: "Sprint 1", startDate: "2026-04-07", duration: 14 },
    { id: "s2", title: "Sprint 2", startDate: "2026-04-21", duration: 14 },
    { id: "s3", title: "Sprint 3", startDate: "2026-05-05", duration: 14 },
  );

  test("picks the sprint whose range contains today", () => {
    assert.equal(findCurrentSprint(iterations, d("2026-04-25")).id, "s2");
  });

  test("start date is inclusive", () => {
    assert.equal(findCurrentSprint(iterations, d("2026-04-21")).id, "s2");
  });

  test("last day of the range still belongs to the sprint", () => {
    assert.equal(findCurrentSprint(iterations, d("2026-05-04")).id, "s2");
  });

  test("end date is exclusive - the next sprint's start day rolls over", () => {
    assert.equal(findCurrentSprint(iterations, d("2026-05-05")).id, "s3");
  });

  test("returns null when today is before any sprint", () => {
    const before = iters({ id: "s1", title: "Sprint 1", startDate: "2026-05-01", duration: 14 });
    assert.equal(findCurrentSprint(before, d("2026-04-25")), null);
  });

  test("returns null when no sprint range contains today", () => {
    const after = iters({ id: "s1", title: "Sprint 1", startDate: "2026-03-01", duration: 14 });
    assert.equal(findCurrentSprint(after, d("2026-04-25")), null);
  });
});

describe("isBacklogHygieneStatus", () => {
  test("empty status is eligible", () => assert.equal(isBacklogHygieneStatus(undefined), true));
  test("Needs Refinement is eligible", () => assert.equal(isBacklogHygieneStatus("Needs Refinement"), true));
  test("emoji-prefixed Needs Refinement is eligible", () => assert.equal(isBacklogHygieneStatus("🛠️ Needs Refinement"), true));
  test("TODO is eligible", () => assert.equal(isBacklogHygieneStatus("TODO"), true));
  test("emoji-prefixed ToDo is eligible", () => assert.equal(isBacklogHygieneStatus("🆕 ToDo"), true));
  test("In Progress is not eligible", () => assert.equal(isBacklogHygieneStatus("In Progress"), false));
  test("In Review is not eligible", () => assert.equal(isBacklogHygieneStatus("In Review"), false));
});

describe("isTerminalStatus", () => {
  test("Done is terminal", () => assert.equal(isTerminalStatus("Done"), true));
  test("emoji-prefixed Done is terminal", () => assert.equal(isTerminalStatus("🍺 Done"), true));
  test("Closed is terminal", () => assert.equal(isTerminalStatus("Closed"), true));
  test("emoji-prefixed Closed is terminal", () => assert.equal(isTerminalStatus("🔒Closed"), true));
  test("In Progress is not terminal", () => assert.equal(isTerminalStatus("In Progress"), false));
  test("Review is not terminal", () => assert.equal(isTerminalStatus("Review"), false));
});

describe("isNeedsRefinementStatus", () => {
  test("Needs Refinement is matched", () => assert.equal(isNeedsRefinementStatus("Needs Refinement"), true));
  test("emoji-prefixed Needs Refinement is matched", () => assert.equal(isNeedsRefinementStatus("🛠️ Needs Refinement"), true));
  test("Next-UP is not Needs Refinement", () => assert.equal(isNeedsRefinementStatus("Next-UP"), false));
  test("emoji-prefixed Next-UP is not Needs Refinement", () => assert.equal(isNeedsRefinementStatus("📋 Next-UP"), false));
});

describe("assertAllowedProjectNumber", () => {
  test("matching project number should be allowed", () => {
    assert.doesNotThrow(() => assertAllowedProjectNumber(DEFAULT_ALLOWED_PROJECT_NUMBER, DEFAULT_ALLOWED_PROJECT_NUMBER));
  });
  test("missing allowed project number should disable the guard", () => {
    assert.doesNotThrow(() => assertAllowedProjectNumber(123, undefined));
  });
  test("mismatched project number should be rejected", () => {
    assert.throws(() => assertAllowedProjectNumber(123, DEFAULT_ALLOWED_PROJECT_NUMBER), /unexpected project/);
  });
});

describe("projectFieldQueryToken", () => {
  test("field display name should become the Projects search token", () => {
    assert.equal(projectFieldQueryToken("Story Points (Number)"), "story-points-(number)");
  });
  test("fallback field name should become the Projects search token", () => {
    assert.equal(projectFieldQueryToken("Story Points"), "story-points");
  });
});

describe("buildRules ignore label", () => {
  const config = {
    projectId: "PROJECT_ID",
    sprintField: { id: "SPRINT_FIELD" },
    statusField: { id: "STATUS_FIELD" },
    needsRefinementOption: { id: "OPTION_ID", name: "🛠️ Needs Refinement" },
    storyPointsField: { name: "Story Points (Number)" },
  };
  const sprints = {
    current: { id: "s1", title: "Sprint 1" },
    next: { id: "s2", title: "Sprint 2" },
  };
  const rules = buildRules(config, sprints);

  test("builds all three hygiene rules", () => {
    assert.equal(rules.length, 3);
  });

  // Every rule must opt out issues carrying the ignore label, quoted because
  // the label contains a slash.
  for (const rule of rules) {
    test(`"${rule.name}" excludes the sprint-hygiene/ignore label`, () => {
      assert.ok(
        rule.filter.includes(`-label:"sprint-hygiene/ignore"`),
        `filter: ${rule.filter}`,
      );
    });
  }
});

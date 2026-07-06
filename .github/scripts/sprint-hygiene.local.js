/**
 * Local runner for sprint-hygiene.js.
 *
 * Usage:
 *   node sprint-hygiene.local.js [--apply] [--limit <n>] [--plan <path>] [--project <number>] [--org <name>] [--allowed-project-number <number>]
 *
 * Runs in dry-run mode by default. Pass --apply to actually update sprints.
 * Use --limit to cap how many items are updated (useful for testing).
 * Requires GH_TOKEN (or GITHUB_TOKEN) with `read:project` and `project` scopes.
 */

import { graphql } from "@octokit/graphql";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { applySprintHygienePlan, collectSprintHygienePlan, DEFAULT_ALLOWED_PROJECT_NUMBER } from "./sprint-hygiene.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    limit: { type: "string" },
    plan: { type: "string" },
    project: { type: "string", default: "10" },
    org: { type: "string", default: "open-component-model" },
    "allowed-project-number": { type: "string", default: String(DEFAULT_ALLOWED_PROJECT_NUMBER) },
  },
});

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Error: GH_TOKEN or GITHUB_TOKEN must be set");
  process.exit(1);
}

const org = values.org;
const projectNumber = Number(values.project);
const allowedProjectNumber = Number(values["allowed-project-number"]);
const dryRun = !values.apply; // dry-run by default, --apply to mutate

const planPath = values.plan;
let limit;
if (values.limit !== undefined) {
  limit = Number.parseInt(values.limit, 10);
  if (!(limit > 0)) {
    console.error(`Error: --limit must be a positive integer, got "${values.limit}"`);
    process.exit(1);
  }
}

if (dryRun) {
  console.log("Running in DRY-RUN mode (pass --apply to make changes)\n");
}
if (limit !== undefined) {
  console.log(`Limiting updates to ${limit} item(s)\n`);
}
if (planPath !== undefined) {
  console.log(`Writing collected plan to ${planPath}\n`);
}

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${token}` },
});

const github = { graphql: graphqlWithAuth };

const core = {
  info: (msg) => console.log(msg),
  warning: (msg) => console.warn(`WARNING: ${msg}`),
  setFailed: (msg) => {
    console.error(`FAILED: ${msg}`);
    process.exitCode = 1;
  },
};

const context = { repo: { owner: org } };

const plan = await collectSprintHygienePlan({ github, core, context, projectNumber, limit, allowedProjectNumber });
if (planPath !== undefined && plan) {
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
}
if (plan) {
  await applySprintHygienePlan({ github, core, plan, dryRun });
}

// @ts-check

/**
 * Automated sprint hygiene for GitHub Projects (v2).
 *
 * Applies named hygiene rules to keep sprint-scoped backlog and refinement
 * items visible in the project views used for sprint planning.
 */

// -- Pure helpers (exported for testing) ----------------------------------

/**
 * Pick the current sprint from a list of active iterations.
 * Falls back to the next upcoming sprint if none contains `today`.
 *
 * @param {Array<{id: string, title: string, startDate: string, duration: number}>} iterations
 * @param {string} today - ISO date string (YYYY-MM-DD)
 * @returns {{id: string, title: string, startDate: string, duration: number} | null}
 */
export function findCurrentSprint(iterations, today) {
  // Find the most recently started iteration that started on or before today.
  const started = iterations
    .filter((i) => i.startDate <= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  if (started.length > 0) {
    return started[started.length - 1];
  }

  // Nothing started yet — pick the nearest upcoming sprint.
  const upcoming = iterations
    .filter((i) => i.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  return upcoming.length > 0 ? upcoming[0] : null;
}

/**
 * Pick the next upcoming sprint from a list of active iterations.
 *
 * @param {Array<{id: string, title: string, startDate: string, duration: number}>} iterations
 * @param {string} today - ISO date string (YYYY-MM-DD)
 * @returns {{id: string, title: string, startDate: string, duration: number} | null}
 */
export function findNextSprint(iterations, today) {
  const upcoming = iterations
    .filter((i) => i.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  return upcoming.length > 0 ? upcoming[0] : null;
}

// -- Constants ------------------------------------------------------------

const EXCLUDED_STATUSES = ["done", "closed"];
const SPRINT_ASSIGN_STATUSES = ["needs refinement", "todo"];
const STATUS_FIELD_NAME = "Status";
const SPRINT_FIELD_NAME = "Sprint";
const STORY_POINTS_FIELD_NAMES = ["Story Points (Number)", "Story Points"];
export const DEFAULT_ALLOWED_PROJECT_NUMBER = 10;

/**
 * Throws when the requested project number is not explicitly allowed.
 */
export function assertAllowedProjectNumber(projectNumber, allowedProjectNumber) {
  if (allowedProjectNumber == null) return;

  if (Number(projectNumber) !== Number(allowedProjectNumber)) {
    throw new Error(`Refusing to run sprint hygiene on unexpected project number ${projectNumber} (expected ${allowedProjectNumber})`);
  }
}

/**
 * Convert a Project field display name into the token accepted by Projects v2
 * search qualifiers such as `no:<field-token>`.
 */
export function projectFieldQueryToken(fieldName) {
  return String(fieldName)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Returns true for statuses that represent unsized backlog/refinement work.
 * This intentionally excludes active current-sprint work such as Next-UP,
 * In Progress, Review, and QA.
 */
export function isBacklogHygieneStatus(statusName) {
  const normalized = (statusName ?? "").trim().toLowerCase();
  return normalized === "" || SPRINT_ASSIGN_STATUSES.some((status) => normalized.includes(status));
}

/**
 * Returns true for terminal project statuses. Project 10 prefixes some status
 * names with emoji, so this checks for the words rather than exact names.
 */
export function isTerminalStatus(statusName) {
  const normalized = (statusName ?? "").trim().toLowerCase();
  return EXCLUDED_STATUSES.some((status) => normalized.includes(status));
}

/**
 * Returns true for the refinement status, including emoji-prefixed variants
 * such as "🛠️ Needs Refinement".
 */
export function isNeedsRefinementStatus(statusName) {
  return (statusName ?? "").trim().toLowerCase().includes("needs refinement");
}

// -- GraphQL queries ------------------------------------------------------

const PROJECT_CONFIG_QUERY = `
  query($org: String!, $number: Int!) {
    organization(login: $org) {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
            ... on ProjectV2IterationField {
              id
              name
              configuration {
                iterations { id title startDate duration }
              }
            }
            ... on ProjectV2Field {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const ITEMS_QUERY = `
  query($projectId: ID!, $cursor: String, $filter: String!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor, query: $filter) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content {
              __typename
              ... on Issue {
                id
                title
                number
                url
                state
              }
              ... on PullRequest {
                id
                title
                number
                url
                state
              }
              ... on DraftIssue {
                title
              }
            }
            sprint: fieldValueByName(name: "Sprint") {
              ... on ProjectV2ItemFieldIterationValue {
                title
                iterationId
              }
            }
            status: fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
              }
            }
            storyPointsNumber: fieldValueByName(name: "Story Points (Number)") {
              ... on ProjectV2ItemFieldNumberValue {
                number
              }
            }
            storyPoints: fieldValueByName(name: "Story Points") {
              ... on ProjectV2ItemFieldNumberValue {
                number
              }
            }
          }
        }
      }
    }
  }
`;

const ADD_COMMENT_MUTATION = `
  mutation($body: String!, $subjectId: ID!) {
    addComment(input: { body: $body, subjectId: $subjectId }) {
      commentEdge { node { id } }
    }
  }
`;

const UPDATE_SPRINT_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { iterationId: $iterationId }
    }) {
      projectV2Item { id }
    }
  }
`;

const UPDATE_STATUS_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) {
      projectV2Item { id }
    }
  }
`;

// -- API helpers ----------------------------------------------------------

/**
 * Resolve the "Needs Refinement" status option from the project's Status field.
 *
 * @returns {{ id: string, name: string }}
 */
function resolveNeedsRefinementOption(statusField) {
  const matches = statusField.options.filter((o) =>
    o.name.includes("Needs Refinement"),
  );

  if (matches.length === 0) {
    throw new Error('Could not find a status option containing "Needs Refinement"');
  }

  return matches[0];
}

/**
 * Fetch project configuration and resolve the fields we need.
 *
 * @returns {{ projectId: string, sprintField: object, statusField: object, needsRefinementOption: {id: string, name: string}, storyPointsField: object | null }}
 */
async function fetchProjectConfig(github, core, { org, projectNumber }) {
  core.info("Fetching project configuration...");
  const data = await github.graphql(PROJECT_CONFIG_QUERY, {
    org,
    number: projectNumber,
  });

  const project = data.organization.projectV2;

  const fields = project.fields.nodes;

  const statusField = fields.find((f) => f.name === STATUS_FIELD_NAME);
  const sprintField = fields.find((f) => f.name === SPRINT_FIELD_NAME);
  const storyPointsField = STORY_POINTS_FIELD_NAMES
    .map((fieldName) => fields.find((f) => f.name === fieldName))
    .find(Boolean) ?? null;

  if (!statusField || !sprintField) {
    throw new Error("Could not find Status or Sprint fields on the project");
  }

  const needsRefinementOption = resolveNeedsRefinementOption(statusField);

  core.info(`Project ID:         ${project.id}`);
  core.info(`Sprint field:       ${sprintField.id}`);
  core.info(`Status match:       ${needsRefinementOption.name} (${needsRefinementOption.id})`);
  core.info(`Story Points field: ${storyPointsField ? `${storyPointsField.name} (${storyPointsField.id})` : "not found - unestimated item rule will be skipped"}`);

  return { projectId: project.id, sprintField, statusField, needsRefinementOption, storyPointsField };
}

/**
 * Fetch all project items matching the server-side filter (paginated).
 * Non-issue items (draft issues, PRs) are dropped and reported separately.
 *
 * @param {{ graphql: Function }} github - GitHub GraphQL client
 * @param {{ info: Function }} core - Logger compatible with @actions/core
 * @param {{ projectId: string, filter: string }} opts
 * @returns {Promise<{ items: Array<object>, droppedProjectItems: Array<object> }>}
 */
async function fetchItems(github, core, { projectId, filter }) {
  core.info(`Filter: ${filter}`);

  const items = [];
  const droppedProjectItems = [];
  let cursor = null;

  do {
    const page = await github.graphql(ITEMS_QUERY, {
      projectId,
      cursor,
      filter,
    });

    const { nodes, pageInfo, totalCount } = page.node.items;
    if (items.length === 0) {
      core.info(`Matched items (server-side): ${totalCount}`);
    }
    for (const item of nodes) {
      if (item.content?.__typename === "Issue") {
        items.push(item);
      } else {
        droppedProjectItems.push(item);
      }
    }

    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  return { items, droppedProjectItems };
}

/**
 * Returns true when the underlying GitHub issue is closed, regardless of the
 * project status column.
 */
function isClosedIssue(item) {
  return item.content?.state === "CLOSED";
}

/**
 * Returns true when the project item is in a terminal status column such as
 * Done or Closed.
 */
function isDoneOrClosedStatus(item) {
  return isTerminalStatus(item.status?.name);
}

function storyPointsValue(item) {
  return item.storyPointsNumber ?? item.storyPoints;
}

/**
 * Returns true when neither supported story-points field has a numeric value.
 * Project 10 uses "Story Points (Number)", while older/local setups may still
 * use "Story Points".
 */
function hasNoStoryPoints(item) {
  const storyPoints = storyPointsValue(item);
  return storyPoints == null || storyPoints.number == null;
}

function rejectionReason(item, checks) {
  for (const check of checks) {
    if (!check.predicate(item)) return check.reason;
  }
  return null;
}

function incrementReason(counts, reason, amount = 1) {
  counts.set(reason, (counts.get(reason) ?? 0) + amount);
}

function logRejectionSummary(core, counts) {
  if (counts.size === 0) return;

  core.info("Not eligible:");
  for (const [reason, count] of counts) {
    core.info(`  ${count} ${reason}`);
  }
}

function droppedProjectItemReason(item) {
  if (item.content?.__typename === "DraftIssue") return "draft issue item";
  if (item.content?.__typename === "PullRequest") return "pull request item";
  return "non-issue project item";
}

function itemSummary(item) {
  return {
    projectItemId: item.id,
    issueId: item.content?.id ?? null,
    number: item.content?.number ?? null,
    title: item.content?.title ?? "unknown",
    url: item.content?.url ?? null,
    state: item.content?.state ?? null,
    status: item.status?.name ?? null,
    sprint: item.sprint?.title ?? null,
    storyPoints: storyPointsValue(item)?.number ?? null,
  };
}

/**
 * Silently attempt to leave a comment on an issue.
 */
async function tryAddComment(github, core, commentedIssueIds, { action }) {
  if (!action.item.issueId) return;
  if (commentedIssueIds.has(action.item.issueId)) return;

  try {
    await github.graphql(ADD_COMMENT_MUTATION, {
      subjectId: action.item.issueId,
      body: action.commentBody,
    });
    commentedIssueIds.add(action.item.issueId);
  } catch (commentErr) {
    core.warning(`  Comment failed on #${action.item.number}: ${commentErr.message}`);
  }
}

/**
 * @param {{ graphql: Function }} github - GitHub GraphQL client
 * @param {{ info: Function, warning: Function }} core - Logger compatible with @actions/core
 * @param {object} args
 * @param {Array<object>} args.actions
 * @param {string} args.ruleName
 * @param {boolean} args.dryRun
 * @param {Set<string>} args.commentedIssueIds
 * @param {(action: object) => Promise<void>} args.applyAction
 * @returns {Promise<{ updated: number, failed: number }>}
 */
async function processActions(github, core, {
  actions,
  ruleName,
  dryRun,
  commentedIssueIds,
  applyAction,
}) {
  if (actions.length === 0) {
    core.info("Nothing to update.");
    return { updated: 0, failed: 0 };
  }

  core.info(`${actions.length} item(s) selected for ${dryRun ? "dry-run update preview" : "update"}:`);

  if (dryRun) {
    core.info("\n--- DRY RUN - no changes will be made ---");
  }

  let updated = 0;
  let failed = 0;

  for (const action of actions) {
    const number = action.item.number ?? "?";
    const title = action.item.title ?? "unknown";
    const itemRef = action.item.url ?? `#${number}`;

    core.info(`${dryRun ? "Would update" : "Updating"} ${itemRef} - ${title}`);
    core.info(`  ${action.description}`);

    if (dryRun) {
      updated += 1;
      continue;
    }

    try {
      await applyAction(action);
      await tryAddComment(github, core, commentedIssueIds, { action });
      core.info("  Done");
      updated += 1;
    } catch (err) {
      core.warning(`  #${number} failed: ${err.message}`);
      failed += 1;
    }
  }

  const updateLabel = dryRun ? "would update" : "updated";
  core.info(`\n${ruleName} summary: ${updated} ${updateLabel}, ${failed} failed`);
  return { updated, failed };
}

// -- Rules ----------------------------------------------------------------

function sprintChange({ projectId, sprintField, targetSprint }) {
  return {
    describe: (item) => `Sprint: ${item.sprint?.title ?? "none"} -> ${targetSprint.title}`,
    mutation: (item) => ({
      type: "setSprint",
      projectId,
      itemId: item.id,
      fieldId: sprintField.id,
      iterationId: targetSprint.id,
    }),
  };
}

function statusChange({ projectId, statusField, option }) {
  return {
    describe: (item) => `Status: ${item.status?.name ?? "(none)"} -> ${option.name}`,
    mutation: (item) => ({
      type: "setStatus",
      projectId,
      itemId: item.id,
      fieldId: statusField.id,
      optionId: option.id,
    }),
  };
}

function quoteProjectFilterValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function applyPlannedMutation(github, action) {
  if (action.mutation.type === "setSprint") {
    await github.graphql(UPDATE_SPRINT_MUTATION, {
      projectId: action.mutation.projectId,
      itemId: action.mutation.itemId,
      fieldId: action.mutation.fieldId,
      iterationId: action.mutation.iterationId,
    });
    return;
  }

  if (action.mutation.type === "setStatus") {
    await github.graphql(UPDATE_STATUS_MUTATION, {
      projectId: action.mutation.projectId,
      itemId: action.mutation.itemId,
      fieldId: action.mutation.fieldId,
      optionId: action.mutation.optionId,
    });
    return;
  }

  throw new Error(`Unsupported planned mutation type: ${action.mutation.type}`);
}

function plannedAction(rule, item) {
  return {
    rule: rule.name,
    item: itemSummary(item),
    description: rule.describeChange(item),
    commentBody: rule.commentBody(item),
    mutation: rule.mutation(item),
  };
}

function buildRules(config, targetSprint) {
  const setTargetSprint = sprintChange({
    projectId: config.projectId,
    sprintField: config.sprintField,
    targetSprint,
  });
  const setNeedsRefinement = statusChange({
    projectId: config.projectId,
    statusField: config.statusField,
    option: config.needsRefinementOption,
  });

  return [
    {
      name: "Roll expired sprint items forward",
      // Project filter: open issues with any sprint before the current sprint.
      filter: "is:open -is:draft sprint:<@current",
      // Item checks: keep all non-terminal items, regardless of active status.
      // This includes ToDo, Next-UP, In Progress, Review, and QA work whose
      // sprint is already in the past.
      checks: [
        { reason: "closed GitHub issue", predicate: (item) => !isClosedIssue(item) },
        { reason: "Done/Closed project status", predicate: (item) => !isDoneOrClosedStatus(item) },
      ],
      describeChange: setTargetSprint.describe,
      commentBody: (item) =>
        `Sprint hygiene: automatically moved from **${item.sprint?.title ?? "none"}** to **${targetSprint.title}** because this issue had an expired sprint.`,
      mutation: setTargetSprint.mutation,
    },
    {
      name: "Mark unestimated items for refinement",
      // Project filter: only open, unestimated issues with a current or
      // upcoming sprint. Items without a sprint are ignored by default to avoid
      // pulling the whole backlog into planning. Already-refinement items are
      // excluded server-side because they already have the target status.
      filter: [
        "is:open",
        "-is:draft",
        "sprint:>=@current",
        `no:${projectFieldQueryToken(config.storyPointsField?.name ?? STORY_POINTS_FIELD_NAMES[0])}`,
        `-status:${quoteProjectFilterValue(config.needsRefinementOption.name)}`,
      ].join(" "),
      skipReason: config.storyPointsField ? null : "no story points field found on project",
      // Item checks: only unsized backlog/refinement candidates. This avoids
      // rewriting active sprint-backlog work such as Next-UP/In Progress/Review.
      checks: [
        { reason: "closed GitHub issue", predicate: (item) => !isClosedIssue(item) },
        { reason: "Done/Closed project status", predicate: (item) => !isDoneOrClosedStatus(item) },
        { reason: "active or in-progress status", predicate: (item) => isBacklogHygieneStatus(item.status?.name) },
        { reason: "already Needs Refinement", predicate: (item) => !isNeedsRefinementStatus(item.status?.name) },
        { reason: "has story points", predicate: (item) => hasNoStoryPoints(item) },
      ],
      describeChange: setNeedsRefinement.describe,
      commentBody: () =>
        `Sprint hygiene: status set to **${config.needsRefinementOption.name}** because this issue has no story points yet.`,
      mutation: setNeedsRefinement.mutation,
    },
    {
      name: "Move refinement work to planning sprint",
      // Project filter: open Needs Refinement issues currently assigned to the
      // active sprint. Next-UP stays in @current because it represents planned
      // current-sprint backlog.
      filter: [
        "is:open",
        "-is:draft",
        "sprint:@current",
        `status:${quoteProjectFilterValue(config.needsRefinementOption.name)}`,
      ].join(" "),
      // Item checks: keep the status check as a defensive fallback in case
      // Project search semantics change.
      checks: [
        { reason: "closed GitHub issue", predicate: (item) => !isClosedIssue(item) },
        { reason: "Done/Closed project status", predicate: (item) => !isDoneOrClosedStatus(item) },
        { reason: "not Needs Refinement", predicate: (item) => isNeedsRefinementStatus(item.status?.name) },
      ],
      describeChange: setTargetSprint.describe,
      commentBody: (item) =>
        `Sprint hygiene: automatically moved from **${item.sprint?.title ?? "none"}** to **${targetSprint.title}** because Needs Refinement items are planned in the next sprint.`,
      mutation: setTargetSprint.mutation,
    },
  ];
}

async function buildRulePlan(github, core, config, rule, { limit }) {
  core.info(`\n=== Collect: ${rule.name} ===`);

  if (rule.skipReason) {
    core.info(`Skipped: ${rule.skipReason}`);
    return {
      name: rule.name,
      filter: rule.filter,
      skipped: true,
      skipReason: rule.skipReason,
      matched: 0,
      planned: 0,
      actions: [],
    };
  }

  const { items, droppedProjectItems } = await fetchItems(github, core, {
    projectId: config.projectId,
    filter: rule.filter,
  });
  const rejectionCounts = new Map();
  for (const item of droppedProjectItems) {
    incrementReason(rejectionCounts, droppedProjectItemReason(item));
  }

  const matching = [];
  for (const item of items) {
    const reason = rejectionReason(item, rule.checks);
    if (reason) {
      incrementReason(rejectionCounts, reason);
    } else {
      matching.push(item);
    }
  }
  const eligible = limit === undefined ? matching : matching.slice(0, limit);

  core.info(`Eligible: ${matching.length}`);
  logRejectionSummary(core, rejectionCounts);
  if (limit !== undefined && matching.length > eligible.length) {
    core.info(`Limited to ${eligible.length} item(s) for this run`);
  }

  return {
    name: rule.name,
    filter: rule.filter,
    skipped: false,
    matched: matching.length,
    planned: eligible.length,
    actions: eligible.map((item) => plannedAction(rule, item)),
  };
}

async function loadConfigAndRules(github, core, context, { projectNumber, limit }) {
  const config = await fetchProjectConfig(
    github, core, { org: context.repo.owner, projectNumber },
  );

  const today = new Date().toISOString().split("T")[0];
  const targetSprint = findNextSprint(config.sprintField.configuration.iterations, today);

  if (!targetSprint) {
    core.setFailed("Could not determine next sprint");
    return null;
  }
  core.info(`Next sprint: ${targetSprint.title} (${targetSprint.id})`);

  return {
    config,
    targetSprint,
    rules: buildRules(config, targetSprint),
    metadata: {
      generatedAt: new Date().toISOString(),
      projectNumber,
      projectId: config.projectId,
      targetSprint: {
        id: targetSprint.id,
        title: targetSprint.title,
        startDate: targetSprint.startDate,
        duration: targetSprint.duration,
      },
      limit: limit ?? null,
    },
  };
}

/**
 * @returns {Promise<object | null>}
 */
export async function collectSprintHygienePlan({ github, core, context, projectNumber, limit, allowedProjectNumber }) {
  if (!projectNumber) {
    core.setFailed("projectNumber is required");
    return null;
  }
  assertAllowedProjectNumber(projectNumber, allowedProjectNumber);

  const loaded = await loadConfigAndRules(github, core, context, { projectNumber, limit });
  if (!loaded) return null;

  const rules = [];
  for (const rule of loaded.rules) {
    rules.push(await buildRulePlan(github, core, loaded.config, rule, { limit }));
  }

  const totalPlanned = rules.reduce((sum, rule) => sum + rule.planned, 0);
  core.info("\n========================================");
  core.info("Sprint hygiene collection complete:");
  for (const rule of rules) {
    const skipped = rule.skipped ? `, skipped: ${rule.skipReason}` : "";
    core.info(`  ${rule.name}: ${rule.planned} planned (${rule.matched} eligible${skipped})`);
  }

  return {
    ...loaded.metadata,
    totalPlanned,
    rules,
  };
}

/**
 * @returns {Promise<Array<{ name: string, updated: number, failed: number }>>}
 */
export async function applySprintHygienePlan({ github, core, plan, dryRun = false }) {
  if (dryRun) core.info("Running in DRY-RUN mode - no changes will be made\n");

  const commentedIssueIds = new Set();
  const results = [];

  for (const rule of plan.rules ?? []) {
    core.info(`\n=== ${rule.name} ===`);
    if (rule.skipped) {
      core.info(`Skipped: ${rule.skipReason}`);
      results.push({ name: rule.name, updated: 0, failed: 0 });
      continue;
    }

    results.push({
      name: rule.name,
      ...await processActions(github, core, {
        actions: rule.actions ?? [],
        ruleName: rule.name,
        dryRun,
        commentedIssueIds,
        applyAction: (action) => applyPlannedMutation(github, action),
      }),
    });
  }

  const totalFailed = results.reduce((sum, result) => sum + result.failed, 0);

  core.info("\n========================================");
  core.info(`Sprint hygiene complete${dryRun ? " (DRY RUN - no changes were made)" : ""}:`);
  const updateLabel = dryRun ? "would update" : "updated";
  for (const result of results) {
    core.info(`  ${result.name}: ${result.updated} ${updateLabel}, ${result.failed} failed`);
  }

  if (totalFailed > 0) {
    core.setFailed(`${totalFailed} item(s) failed to update across all rules`);
  }

  return results;
}

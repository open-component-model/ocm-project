// @ts-check

/**
 * Automated sprint hygiene for GitHub Projects (v2).
 *
 * Task A: Move all expired-sprint items (except Done/Closed) to the current sprint.
 * Task B: Assign the current sprint to no-sprint items whose status is empty,
 *         "Needs Refinement", or "TODO".
 * Task C: Set status to "Needs Refinement" on open items that have no story points
 *         and are not already in a terminal or refinement state.
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

// -- Constants ------------------------------------------------------------

const EXCLUDED_STATUSES = ["done", "closed"];
const SPRINT_ASSIGN_STATUSES = ["needs refinement", "todo"];

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
              ... on Issue {
                id
                title
                number
                url
                state
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
 * Returns the full option object {id, name} so callers can use either for
 * filter strings (name) or mutations (id).
 * Throws if no match is found or if the name contains characters that would
 * break the Projects v2 query filter syntax.
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

  const option = matches[0];

  if (/["\\/]/.test(option.name)) {
    throw new Error(`Status name contains characters unsupported in the filter (", \\, /): ${option.name}`);
  }

  return option;
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

  const statusField = fields.find((f) => f.name === "Status");
  const sprintField = fields.find((f) => f.name === "Sprint");
  const storyPointsField = fields.find((f) => f.name === "Story Points") ?? null;

  if (!statusField || !sprintField) {
    throw new Error("Could not find Status or Sprint fields on the project");
  }

  const needsRefinementOption = resolveNeedsRefinementOption(statusField);

  core.info(`Project ID:         ${project.id}`);
  core.info(`Sprint field:       ${sprintField.id}`);
  core.info(`Status match:       ${needsRefinementOption.name} (${needsRefinementOption.id})`);
  core.info(`Story Points field: ${storyPointsField?.id ?? "not found — Task C will be skipped"}`);

  return { projectId: project.id, sprintField, statusField, needsRefinementOption, storyPointsField };
}

/**
 * Fetch all project items matching the server-side filter (paginated).
 * Non-issue items (draft issues, PRs) are silently dropped.
 *
 * @param {{ projectId: string, filter: string, limit?: number }} opts
 */
async function fetchItems(github, core, { projectId, filter, limit }) {
  core.info(`Filter: ${filter}`);

  const items = [];
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
    items.push(...nodes.filter((n) => n.content?.number != null));

    if (limit !== undefined && items.length >= limit) {
      items.length = limit;
      break;
    }

    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  return items;
}

/**
 * Returns true if an item should be skipped (Done, Closed, or issue is closed in GitHub).
 */
function isExcluded(item) {
  const statusName = (item.status?.name ?? "").toLowerCase();
  if (EXCLUDED_STATUSES.includes(statusName)) return true;
  if (item.content?.state === "CLOSED") return true;
  return false;
}

/**
 * Silently attempt to leave a comment on an issue.
 */
async function tryAddComment(github, core, { item, body }) {
  if (!item.content?.id) return;
  try {
    await github.graphql(ADD_COMMENT_MUTATION, { subjectId: item.content.id, body });
  } catch (commentErr) {
    core.warning(`  Comment failed on #${item.content.number}: ${commentErr.message}`);
  }
}

// -- Tasks ----------------------------------------------------------------

/**
 * Task A: Move every item whose sprint has expired (and is not Done/Closed)
 * to the current sprint.
 *
 * @returns {{ updated: number, failed: number }}
 */
async function taskMoveExpiredSprints(github, core, { projectId, sprintField }, currentSprint, dryRun, limit) {
  core.info("\n=== Task A: Move expired-sprint items to current sprint ===");

  const items = await fetchItems(github, core, { projectId, filter: "sprint:<@current", limit });
  const eligible = items.filter((item) => !isExcluded(item));

  core.info(`Eligible (not Done/Closed): ${eligible.length}`);

  if (eligible.length === 0) {
    core.info("Nothing to update.");
    return { updated: 0, failed: 0 };
  }

  if (dryRun) {
    core.info("\n--- DRY RUN — no changes will be made ---");
    for (const item of eligible) {
      const number = item.content?.number ?? "?";
      const title = item.content?.title ?? "unknown";
      const oldSprint = item.sprint?.title ?? "none";
      core.info(`  #${number} – ${title}  (${oldSprint} → ${currentSprint.title})`);
    }
    return { updated: eligible.length, failed: 0 };
  }

  const updatedItems = [];
  const failedItems = [];

  for (const item of eligible) {
    const number = item.content?.number ?? "?";
    const title = item.content?.title ?? "unknown";
    const oldSprint = item.sprint?.title ?? "none";

    core.info(`Updating #${number} – ${title}`);
    core.info(`  Sprint: ${oldSprint} → ${currentSprint.title}`);

    try {
      await github.graphql(UPDATE_SPRINT_MUTATION, {
        projectId,
        itemId: item.id,
        fieldId: sprintField.id,
        iterationId: currentSprint.id,
      });
      await tryAddComment(github, core, {
        item,
        body: `Sprint hygiene: automatically moved from **${oldSprint}** to **${currentSprint.title}** because this issue had an expired sprint.`,
      });
      core.info("  Done");
      updatedItems.push(item);
    } catch (err) {
      core.warning(`  #${number} failed: ${err.message}`);
      failedItems.push(item);
    }
  }

  core.info(`\nTask A summary: ${updatedItems.length} updated, ${failedItems.length} failed`);
  if (updatedItems.length > 0) {
    for (const item of updatedItems) {
      core.info(`  - ${item.content?.url ?? `#${item.content?.number}`}`);
    }
  }

  return { updated: updatedItems.length, failed: failedItems.length };
}

/**
 * Task B: Assign the current sprint to items that have no sprint and whose
 * status is empty, "Needs Refinement", or "TODO".
 *
 * @returns {{ updated: number, failed: number }}
 */
async function taskAssignNoSprintItems(github, core, { projectId, sprintField }, currentSprint, dryRun) {
  core.info("\n=== Task B: Assign current sprint to no-sprint items ===");

  const items = await fetchItems(github, core, { projectId, filter: "no:sprint" });

  const eligible = items.filter((item) => {
    if (isExcluded(item)) return false;
    const statusName = (item.status?.name ?? "").trim().toLowerCase();
    return statusName === "" || SPRINT_ASSIGN_STATUSES.includes(statusName);
  });

  core.info(`Eligible (no status / Needs Refinement / TODO): ${eligible.length}`);

  if (eligible.length === 0) {
    core.info("Nothing to update.");
    return { updated: 0, failed: 0 };
  }

  if (dryRun) {
    core.info("\n--- DRY RUN — no changes will be made ---");
    for (const item of eligible) {
      const number = item.content?.number ?? "?";
      const title = item.content?.title ?? "unknown";
      const statusName = item.status?.name ?? "(none)";
      core.info(`  #${number} – ${title}  (status: ${statusName} → sprint: ${currentSprint.title})`);
    }
    return { updated: eligible.length, failed: 0 };
  }

  const updatedItems = [];
  const failedItems = [];

  for (const item of eligible) {
    const number = item.content?.number ?? "?";
    const title = item.content?.title ?? "unknown";

    core.info(`Updating #${number} – ${title}`);
    core.info(`  Sprint: (none) → ${currentSprint.title}`);

    try {
      await github.graphql(UPDATE_SPRINT_MUTATION, {
        projectId,
        itemId: item.id,
        fieldId: sprintField.id,
        iterationId: currentSprint.id,
      });
      await tryAddComment(github, core, {
        item,
        body: `Sprint hygiene: automatically assigned to **${currentSprint.title}**.`,
      });
      core.info("  Done");
      updatedItems.push(item);
    } catch (err) {
      core.warning(`  #${number} failed: ${err.message}`);
      failedItems.push(item);
    }
  }

  core.info(`\nTask B summary: ${updatedItems.length} updated, ${failedItems.length} failed`);
  if (updatedItems.length > 0) {
    for (const item of updatedItems) {
      core.info(`  - ${item.content?.url ?? `#${item.content?.number}`}`);
    }
  }

  return { updated: updatedItems.length, failed: failedItems.length };
}

/**
 * Task C: Set status to "Needs Refinement" on open items that have no story
 * points and are not already in a terminal or refinement state.
 * Skipped entirely when no "Story Points" field exists on the project.
 *
 * @returns {{ updated: number, failed: number }}
 */
async function taskMarkNeedsRefinement(github, core, { projectId, statusField, needsRefinementOption, storyPointsField }, dryRun) {
  if (!storyPointsField) {
    core.info('\n=== Task C: Skipped (no "Story Points" field found on project) ===');
    return { updated: 0, failed: 0 };
  }

  core.info("\n=== Task C: Mark no-story-points items as Needs Refinement ===");

  const items = await fetchItems(github, core, { projectId, filter: "is:open" });

  const eligible = items.filter((item) => {
    if (isExcluded(item)) return false;
    const statusName = (item.status?.name ?? "").toLowerCase();
    if (statusName.includes("needs refinement")) return false;
    return item.storyPoints == null || item.storyPoints?.number == null;
  });

  core.info(`Eligible (no story points, not already Needs Refinement/Done/Closed): ${eligible.length}`);

  if (eligible.length === 0) {
    core.info("Nothing to update.");
    return { updated: 0, failed: 0 };
  }

  if (dryRun) {
    core.info("\n--- DRY RUN — no changes will be made ---");
    for (const item of eligible) {
      const number = item.content?.number ?? "?";
      const title = item.content?.title ?? "unknown";
      const oldStatus = item.status?.name ?? "(none)";
      core.info(`  #${number} – ${title}  (${oldStatus} → ${needsRefinementOption.name})`);
    }
    return { updated: eligible.length, failed: 0 };
  }

  const updatedItems = [];
  const failedItems = [];

  for (const item of eligible) {
    const number = item.content?.number ?? "?";
    const title = item.content?.title ?? "unknown";
    const oldStatus = item.status?.name ?? "(none)";

    core.info(`Updating #${number} – ${title}`);
    core.info(`  Status: ${oldStatus} → ${needsRefinementOption.name}`);

    try {
      await github.graphql(UPDATE_STATUS_MUTATION, {
        projectId,
        itemId: item.id,
        fieldId: statusField.id,
        optionId: needsRefinementOption.id,
      });
      await tryAddComment(github, core, {
        item,
        body: `Sprint hygiene: status set to **${needsRefinementOption.name}** because this issue has no story points yet.`,
      });
      core.info("  Done");
      updatedItems.push(item);
    } catch (err) {
      core.warning(`  #${number} failed: ${err.message}`);
      failedItems.push(item);
    }
  }

  core.info(`\nTask C summary: ${updatedItems.length} updated, ${failedItems.length} failed`);
  if (updatedItems.length > 0) {
    for (const item of updatedItems) {
      core.info(`  - ${item.content?.url ?? `#${item.content?.number}`}`);
    }
  }

  return { updated: updatedItems.length, failed: failedItems.length };
}

// -- Main entry point -----------------------------------------------------

/**
 * @param {object} args
 * @param {import('@actions/github-script').AsyncFunctionArguments["github"]} args.github
 * @param {import('@actions/github-script').AsyncFunctionArguments["core"]} args.core
 * @param {import('@actions/github-script').AsyncFunctionArguments["context"]} args.context
 * @param {number} args.projectNumber - GitHub Projects (v2) project number
 * @param {boolean} [args.dryRun] - If true, log what would be updated without making changes
 * @param {number} [args.limit] - Cap on items processed by Task A (undefined = all)
 */
export default async function updateExpiredSprints({ github, core, context, projectNumber, dryRun = false, limit }) {
  if (!projectNumber) {
    core.setFailed("projectNumber is required");
    return;
  }

  if (dryRun) core.info("Running in DRY-RUN mode — no changes will be made\n");

  const config = await fetchProjectConfig(
    github, core, { org: context.repo.owner, projectNumber },
  );

  const today = new Date().toISOString().split("T")[0];
  const currentSprint = findCurrentSprint(config.sprintField.configuration.iterations, today);

  if (!currentSprint) {
    core.setFailed("Could not determine current sprint");
    return;
  }
  core.info(`Current sprint: ${currentSprint.title} (${currentSprint.id})`);

  const resultA = await taskMoveExpiredSprints(github, core, config, currentSprint, dryRun, limit);
  const resultB = await taskAssignNoSprintItems(github, core, config, currentSprint, dryRun);
  const resultC = await taskMarkNeedsRefinement(github, core, config, dryRun);

  const totalFailed = resultA.failed + resultB.failed + resultC.failed;

  core.info("\n========================================");
  core.info("Sprint hygiene complete:");
  core.info(`  A  expired sprint → current sprint:    ${resultA.updated} updated, ${resultA.failed} failed`);
  core.info(`  B  no sprint + target status → sprint: ${resultB.updated} updated, ${resultB.failed} failed`);
  core.info(`  C  no story points → Needs Refinement: ${resultC.updated} updated, ${resultC.failed} failed`);

  if (totalFailed > 0) {
    core.setFailed(`${totalFailed} item(s) failed to update across all tasks`);
  }
}

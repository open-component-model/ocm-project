const puppeteer = require('puppeteer');
const moment = require('moment');

async function updateProjectItems(orgName, projectNumber, statusToUpdate, newStatus, olderThanDays) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Navigate to the project board
  const projectUrl = `https://github.com/orgs/${orgName}/projects/${projectNumber}`;
  await page.goto(projectUrl, { waitUntil: 'networkidle0' });

  // Find project items with the specified status and older than the given number of days
  const itemsToUpdate = await page.$$eval('.js-project-status-field', (fields, status, days) => {
    const olderThanDate = moment().subtract(days, 'days').toDate();
    return fields.filter(field => {
      const itemUpdatedAt = moment(field.closest('[data-issue-updated-at]').getAttribute('data-issue-updated-at'));
      return field.textContent === status && itemUpdatedAt.isBefore(olderThanDate);
    }).map(field => field.closest('[data-item-id]').getAttribute('data-item-id'));
  }, statusToUpdate, olderThanDays);

  // Update the custom field value for each matching project item
  for (const itemNumber of itemsToUpdate) {
    const itemSelector = `[data-item-id="${itemNumber}"]`;
    const item = await page.waitForSelector(itemSelector);
    const statusDropdown = await item.$('.js-project-status-field');
    await statusDropdown.click();
    const statusOption = await page.waitForSelector(`.js-project-status-field option[value="${newStatus}"]`);
    await statusOption.click();
  }

  await browser.close();
}

async function main() {
  const orgName = process.env.GITHUB_ORGANIZATION;
  const projectNumber = process.env.PROJECT_NUMBER;
  const statusToUpdate = process.env.STATUS_TO_UPDATE;
  const newStatus = process.env.NEW_STATUS;
  const olderThanDays = process.env.OLDER_THAN_DAYS;

  await updateProjectItems(orgName, projectNumber, statusToUpdate, newStatus, olderThanDays);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
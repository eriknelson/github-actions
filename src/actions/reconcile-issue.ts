import * as core from "@actions/core";
import * as github from "@actions/github";
import { GitHubIssue } from "../github-issue";
import { Jira } from "../jira";
import { components } from "@octokit/openapi-types";

type Issue = components["schemas"]["issue"];

const commentPrefix = "This issue synced with";

async function reconcileIssue() {
  const inputs = {
    token: core.getInput("token"),
    jiraBaseUrl: core.getInput("jiraBaseUrl", { required: true }),
    jiraToken: core.getInput("jiraToken", { required: true }),
    jiraProject: core.getInput("jiraProject", { required: true }),
    requireMissingLabels: core
      .getInput("requireMissingLabels", { required: true })
      .split(",")
      .map((element) => element.trim()),
    additionalLabels: core.getInput("additionalLabels").split(","),
  };

  // First, make sure we are looking at the right thing.
  const context = github.context;
  const payload = context.payload;
  if (!payload.issue) {
    core.warning("Not an issue, skipping");
    return;
  }

  // Then, go get the issue.
  const octokit = github.getOctokit(inputs.token);
  const { owner, repo, number } = context.issue;
  let issue: Issue;
  try {
    ({ data: issue } = await octokit.rest.issues.get({
      owner: owner,
      repo: repo,
      issue_number: number,
    }));
  } catch (error) {
    core.setFailed(
      `Failed to get GitHub Issue ${owner}/${repo}#${number}: ${error}`
    );
    return;
  }

  // Instantiate our opinionated represenation of {gh|jira} issues
  const ghIssue = new GitHubIssue(inputs.token, owner, repo, number, issue);
  const jira = new Jira(
    inputs.jiraBaseUrl,
    inputs.jiraProject,
    inputs.jiraToken
  );

  // Only states allowed for GitHub issues are open/closed
  // https://docs.github.com/en/rest/issues/issues#get-an-issue
  if (ghIssue.isClosed()) {
    let jiraUrl: string;
    try {
      jiraUrl = await jira.getIssueUrl(ghIssue.key());
      if (jiraUrl == "") {
        core.info("No corresponding Jira found for this closed issue");
        return;
      }
      core.info("Jira issue url found: " + jiraUrl);
    } catch (error) {
      core.setFailed(
        `Something went wrong searching for issue "${ghIssue.key()}" in Jira: ${error}`
      );
      return;
    }

    try {
      if (!(await jira.issueIsDone(jiraUrl))) {
        await jira.transitionDone(jiraUrl);
      }
    } catch (error) {
      core.setFailed(`Something went wrong closing issue ${jiraUrl}: ${error}`);
    }
    const htmlUrl = await jira.getJiraHTMLUrl(jiraUrl);
    await ghIssue.ensureComment(`${commentPrefix}: ${htmlUrl}`);
    return;
  }

  const requiredMissingLabels = inputs.requireMissingLabels.filter((label) =>
    ghIssue.hasLabel(label)
  );
  if (requiredMissingLabels.length !== 0) {
    core.warning(
      `This issue has ${requiredMissingLabels} that indicate this issue is not triaged.`
    );
    return;
  }

  // jiraIssueParams are the primary fields we are concerned with updating
  // on the jira issue.
  // We will apply the following labels:
  // + the additional labels specified in the action
  // + the repo id (ie. konveyor/crane) for filtering
  // + the key (ie. konveyor/crane#1234) that links the Issue
  // TODO(djzager): since jira doesn't allow labels with spaces we
  // will likely need to slugify the github labels AND find a way to distinguish
  // github labels from jira labels (maybe a gh: prefix).
  let jiraIssueParams = {
    isBug: ghIssue.isBug(),
    summary: ghIssue.getTitle(),
    description: ghIssue.getBody(),
    labels: inputs.additionalLabels.concat(
      ghIssue.getRepoId(),
      ghIssue.key(),
      ghIssue.getLabelsSlugified()
    ),
    url: ghIssue.getUrl(),
    key: ghIssue.key(),
  };

  let jiraUrl: string;
  try {
    // If we find a linked jira, update it
    jiraUrl = await jira.getIssueUrl(ghIssue.key());
  } catch (error) {
    core.setFailed(
      `Failed to get Jira issue for key ${ghIssue.key()}: ${error}`
    );
    return;
  }

  // Update the issue if it already exists
  try {
    if (jiraUrl != "") {
      core.info(`Jira issue url (${jiraUrl}) found, will update`);
      await jira.updateIssue(jiraUrl, jiraIssueParams);
      const htmlUrl = await jira.getJiraHTMLUrl(jiraUrl);
      await ghIssue.ensureComment(`${commentPrefix}: ${htmlUrl}`);
      return;
    }
  } catch (error) {
    core.setFailed(`Failed to update Jira Issue with url ${jiraUrl}: ${error}`);
    return;
  }

  // Create the issue if it doesn't
  try {
    jiraUrl = await jira.createIssue(jiraIssueParams);
    const htmlUrl = await jira.getJiraHTMLUrl(jiraUrl);
    await ghIssue.ensureComment(`${commentPrefix}: ${htmlUrl}`);
  } catch (error) {
    core.setFailed(`Failed to create Jira Issue: ${error}`);
  }
  return;
}

reconcileIssue();

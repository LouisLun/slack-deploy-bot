const {
  GitHubClient,
  getLatestLabeledPR,
  getNextVersion,
  triggerWorkflow,
  waitForWorkflowRun,
  createRelease,
  createTag,
  mergePR,
} = require('../services/github');
const { readConfig } = require('../services/config');
const { postMessage } = require('../services/slack');

async function runHotfix({ token, projectName, channelId }) {
  const gh = new GitHubClient(token);

  try {
    const config = await readConfig();
    const projectConfig = config.projects?.[projectName];

    if (!projectConfig) {
      await postMessage(channelId, `:x: Project \`${projectName}\` not found in config.`);
      return;
    }

    const [owner, repo] = projectConfig.repo.split('/');

    const pr = await getLatestLabeledPR(gh, owner, repo, 'hotfix');
    if (!pr) {
      await postMessage(
        channelId,
        `:x: No open PR with label \`hotfix\` found in \`${projectConfig.repo}\`.`
      );
      return;
    }

    const version = await getNextVersion(gh, owner, repo);

    await postMessage(
      channelId,
      `:fire: Starting hotfix for *${projectName}* → \`${version}\` (PR: ${pr.html_url})`
    );

    // 1. Merge PR
    const merged = await mergePR(gh, owner, repo, pr.number, `Hotfix ${version}`);
    await postMessage(channelId, `[${projectName}] <${pr.html_url}|PR #${pr.number}> merged :merged:`);

    // 2. Create version tag on merge commit
    await createTag(gh, owner, repo, version, merged.sha);
    await postMessage(channelId, `[${projectName}] Tag \`${version}\` created`);

    // 3. Trigger workflows on the version tag
    await Promise.all(
      projectConfig.workflows.map(async (workflow) => {
        await postMessage(channelId, `[${projectName}] Triggering \`${workflow}\` on \`${version}\``);

        const since = new Date(Date.now() - 2000);
        await triggerWorkflow(gh, owner, repo, workflow, version);

        const run = await waitForWorkflowRun(gh, owner, repo, workflow, version, since);

        if (run.conclusion !== 'success') {
          throw new Error(`\`${workflow}\` failed (conclusion: \`${run.conclusion}\`)`);
        }

        await postMessage(channelId, `[${projectName}] \`${workflow}\` :white_check_mark:`);
      })
    );

    // 4. Create GitHub Release
    await createRelease(
      gh,
      owner,
      repo,
      version,
      merged.sha,
      `Hotfix deployed via PR ${pr.html_url}`
    );

    await postMessage(
      channelId,
      `:tada: Hotfix complete! <${pr.html_url}|PR #${pr.number}> merged, release \`${version}\` created for *${projectName}*`
    );
  } catch (err) {
    await postMessage(channelId, `:x: Hotfix failed for ${projectName}: ${err.message}`);
    console.error('runHotfix error:', err);
  }
}

module.exports = { runHotfix };

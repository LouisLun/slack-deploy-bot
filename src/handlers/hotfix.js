const {
  GitHubClient,
  getLatestLabeledPR,
  getNextVersion,
  triggerWorkflow,
  waitForWorkflowRun,
  createRelease,
  createTag,
  deleteTag,
  mergePR,
} = require('../services/github');
const { readConfig } = require('../services/config');
const { postMessage } = require('../services/slack');

async function runHotfix({ token, projectName, releaseTitle, userId, channelId }) {
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
      `:fire: Starting hotfix for *${projectName}* → \`${version}\` — *${releaseTitle}* (by <@${userId}>) (PR: ${pr.html_url})`
    );

    // 1. Merge PR
    const merged = await mergePR(gh, owner, repo, pr.number, `Merge pull request #${pr.number} from ${pr.head.repo.owner.login}/${pr.head.ref}`);
    await postMessage(channelId, `[${projectName}] <${pr.html_url}|PR #${pr.number}> merged :merged:`);

    if (projectConfig.mergeOnly) {
      await postMessage(channelId, `:tada: Hotfix complete! <${pr.html_url}|PR #${pr.number}> merged for *${projectName}*`);
      return;
    }

    // 2. Create version tag on merge commit
    await createTag(gh, owner, repo, version, merged.sha);
    await postMessage(channelId, `[${projectName}] Tag \`${version}\` created`);

    try {
      // 3. Trigger workflows on the version tag
      await Promise.all(
        (projectConfig.workflows ?? []).map(async (workflow) => {
          await postMessage(channelId, `[${projectName}] Triggering \`${workflow}\` on \`${version}\``);

          const since = new Date(Date.now() - 2000);
          await triggerWorkflow(gh, owner, repo, workflow, version);

          const run = await waitForWorkflowRun(gh, owner, repo, workflow, version, since);

          if (run.conclusion !== 'success') {
            throw new Error(`\`${workflow}\` failed (\`${run.conclusion}\`) — <${run.html_url}|View run>`);
          }

          await postMessage(channelId, `[${projectName}] \`${workflow}\` :white_check_mark: <${run.html_url}|View run>`);
        })
      );

      // 4. Create GitHub Release
      await createRelease(
        gh,
        owner,
        repo,
        version,
        merged.sha,
        releaseTitle,
        `Hotfix deployed via PR ${pr.html_url}`
      );

      await postMessage(
        channelId,
        `:tada: Hotfix complete! <${pr.html_url}|PR #${pr.number}> merged, release \`${version}\` created for *${projectName}*`
      );
    } catch (err) {
      await deleteTag(gh, owner, repo, version).catch(() => {});
      await postMessage(channelId, `[${projectName}] Tag \`${version}\` deleted after failure`);
      throw err;
    }
  } catch (err) {
    await postMessage(channelId, `:x: Hotfix failed for ${projectName}: ${err.message}`);
    console.error('runHotfix error:', err);
  }
}

module.exports = { runHotfix };

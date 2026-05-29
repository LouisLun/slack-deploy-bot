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

async function runDeploy({ token, groupName, channelId }) {
  const gh = new GitHubClient(token);

  try {
    const config = await readConfig();
    const steps = config.groups?.[groupName];

    if (!steps) {
      await postMessage(channelId, `Error: group \`${groupName}\` not found in config.`);
      return;
    }

    await postMessage(channelId, `:rocket: Starting deploy for group *${groupName}*`);

    for (const stepDef of steps) {
      const { step, projects } = stepDef;
      const names = projects.map((p) => p.name).join(', ');
      await postMessage(channelId, `:arrow_right: Step ${step}: ${names}`);

      // Resolve each project: find PR, compute version
      const tasks = [];
      const skipped = [];

      for (const project of projects) {
        const [owner, repo] = project.repo.split('/');
        const pr = await getLatestLabeledPR(gh, owner, repo, groupName);

        if (!pr) {
          skipped.push(project.name);
          continue;
        }

        const version = await getNextVersion(gh, owner, repo);
        tasks.push({ project, pr, version, owner, repo });
      }

      if (skipped.length > 0) {
        await postMessage(
          channelId,
          `:warning: Step ${step}: no matching PR (label: \`${groupName}\`) — skipped: ${skipped.join(', ')}`
        );
      }

      if (tasks.length === 0) {
        await postMessage(channelId, `Step ${step}: nothing to deploy.`);
        continue;
      }

      // All projects in this step run concurrently; workflows within each project run sequentially
      const results = await Promise.allSettled(
        tasks.map((t) => deployProject(gh, t, channelId))
      );

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        const reasons = failures.map((f) => f.reason?.message || String(f.reason)).join('; ');
        await postMessage(
          channelId,
          `:x: Step ${step}: ${failures.length} project(s) failed — aborting. Errors: ${reasons}`
        );
        return;
      }

      await postMessage(channelId, `:white_check_mark: Step ${step} complete.`);
    }

    await postMessage(channelId, `:tada: Deploy complete for group *${groupName}*`);
  } catch (err) {
    await postMessage(channelId, `:x: Deploy failed: ${err.message}`);
    console.error('runDeploy error:', err);
  }
}

async function deployProject(gh, { project, pr, version, owner, repo }, channelId) {
  // 1. Merge PR
  const merged = await mergePR(gh, owner, repo, pr.number, `Merge pull request ${pr.number} from ${pr.head.ref}`);
  await postMessage(channelId, `[${project.name}] <${pr.html_url}|PR #${pr.number}> merged :merged:`);

  // 2. Create version tag on merge commit
  await createTag(gh, owner, repo, version, merged.sha);
  await postMessage(channelId, `[${project.name}] Tag \`${version}\` created`);

  try {
    // 3. Trigger workflows on the version tag
    await Promise.all(
      project.workflows.map(async (workflow) => {
        await postMessage(channelId, `[${project.name}] Triggering \`${workflow}\` on \`${version}\``);

        const since = new Date(Date.now() - 2000);
        await triggerWorkflow(gh, owner, repo, workflow, version);

        const run = await waitForWorkflowRun(gh, owner, repo, workflow, version, since);

        if (run.conclusion !== 'success') {
          throw new Error(
            `[${project.name}] ${workflow} failed (\`${run.conclusion}\`) — <${run.html_url}|View run>`
          );
        }

        await postMessage(channelId, `[${project.name}] \`${workflow}\` :white_check_mark: <${run.html_url}|View run>`);
      })
    );

    // 4. Create GitHub Release
    await createRelease(
      gh,
      owner,
      repo,
      version,
      merged.sha,
      `Deployed via PR ${pr.html_url}`
    );

    await postMessage(channelId, `[${project.name}] Release \`${version}\` created :label:`);
  } catch (err) {
    await deleteTag(gh, owner, repo, version).catch(() => {});
    await postMessage(channelId, `[${project.name}] Tag \`${version}\` deleted after failure`);
    throw err;
  }
}

module.exports = { runDeploy };

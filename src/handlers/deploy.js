const {
  GitHubClient,
  getLatestLabeledPR,
  getNextVersion,
  triggerWorkflow,
  waitForWorkflowRun,
  createRelease,
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
  const branch = pr.head.ref;

  await Promise.all(
    project.workflows.map(async (workflow) => {
      await postMessage(channelId, `[${project.name}] Triggering \`${workflow}\` on \`${branch}\``);

      const since = new Date(Date.now() - 2000);
      await triggerWorkflow(gh, owner, repo, workflow, branch, { version });

      const run = await waitForWorkflowRun(gh, owner, repo, workflow, branch, since);

      if (run.conclusion !== 'success') {
        throw new Error(
          `[${project.name}] ${workflow} finished with conclusion \`${run.conclusion}\``
        );
      }

      await postMessage(channelId, `[${project.name}] \`${workflow}\` :white_check_mark:`);
    })
  );

  const merged = await mergePR(gh, owner, repo, pr.number, `Deploy ${version}`);
  await postMessage(channelId, `[${project.name}] PR #${pr.number} merged :merged:`);

  await createRelease(
    gh,
    owner,
    repo,
    version,
    merged.sha,
    `Deployed via PR ${pr.html_url}`
  );

  await postMessage(channelId, `[${project.name}] Release \`${version}\` created :label:`);
}

module.exports = { runDeploy };

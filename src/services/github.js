const GITHUB_API = 'https://api.github.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GitHubClient {
  constructor(token) {
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async request(method, path, body = null) {
    const opts = { method, headers: this.headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${GITHUB_API}${path}`, opts);

    if (res.status === 204) return null;
    const data = await res.json();

    if (!res.ok) {
      const msg = data?.message || JSON.stringify(data);
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${msg}`);
    }
    return data;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body);
  }
}

async function getLatestLabeledPR(client, owner, repo, label) {
  const prs = await client.get(
    `/repos/${owner}/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`
  );
  return (
    prs.find((pr) =>
      pr.labels.some((l) => l.name.toLowerCase() === label.toLowerCase())
    ) || null
  );
}

async function getNextVersion(client, owner, repo) {
  try {
    const releases = await client.get(
      `/repos/${owner}/${repo}/releases?per_page=1`
    );
    if (!releases || releases.length === 0) return 'v0.0.1';

    const match = releases[0].tag_name.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!match) return 'v0.0.1';

    const [, major, minor, patch] = match;
    return `v${major}.${minor}.${parseInt(patch, 10) + 1}`;
  } catch {
    return 'v0.0.1';
  }
}

async function triggerWorkflow(client, owner, repo, workflowFile, ref, inputs = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.post(
        `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
        { ref, inputs }
      );
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

async function waitForWorkflowRun(client, owner, repo, workflowFile, branch, since) {
  // Give GitHub up to 60s to register the new run
  let runId = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const data = await client.get(
      `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs` +
        `?branch=${encodeURIComponent(branch)}&per_page=5`
    );
    const run = data?.workflow_runs?.find((r) => new Date(r.created_at) >= since);
    if (run) {
      runId = run.id;
      break;
    }
  }

  if (!runId) {
    throw new Error(`Workflow run not found within 60s: ${workflowFile}`);
  }

  // Poll until complete (max 30 minutes)
  for (let i = 0; i < 120; i++) {
    await sleep(15000);
    const run = await client.get(`/repos/${owner}/${repo}/actions/runs/${runId}`);
    if (run.status === 'completed') return run;
  }

  throw new Error(`Workflow timed out after 30 minutes: ${workflowFile}`);
}

async function createRelease(client, owner, repo, tag, sha, body = '') {
  await client.post(`/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    target_commitish: sha,
    name: tag,
    body,
    draft: false,
    prerelease: false,
  });
}

async function createTag(client, owner, repo, tag, sha) {
  try {
    await client.post(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/tags/${tag}`,
      sha,
    });
  } catch (err) {
    if (err.message.includes('Reference already exists')) {
      // Force update existing tag to new SHA
      await client.request('PATCH', `/repos/${owner}/${repo}/git/refs/tags/${tag}`, {
        sha,
        force: true,
      });
    } else {
      throw err;
    }
  }
}

async function deleteTag(client, owner, repo, tag) {
  await client.request('DELETE', `/repos/${owner}/${repo}/git/refs/tags/${tag}`);
}

async function mergePR(client, owner, repo, pullNumber, commitTitle) {
  return client.request('PUT', `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
    commit_title: commitTitle,
    merge_method: 'merge',
  });
}

async function exchangeCodeForToken(code) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`OAuth token exchange failed: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

module.exports = {
  GitHubClient,
  getLatestLabeledPR,
  getNextVersion,
  triggerWorkflow,
  waitForWorkflowRun,
  createRelease,
  createTag,
  deleteTag,
  mergePR,
  exchangeCodeForToken,
};

const express = require('express');
const { consumeState } = require('../services/oauthState');
const { exchangeCodeForToken } = require('../services/github');
const { runDeploy } = require('../handlers/deploy');
const { runHotfix } = require('../handlers/hotfix');

const router = express.Router();

const HTML_SUCCESS = `<!DOCTYPE html><html><head><title>Authorized</title></head><body>
<h2>Authorized!</h2><p>Deployment started. Check Slack for updates. You can close this tab.</p>
</body></html>`;

const HTML_ERROR = (msg) =>
  `<!DOCTYPE html><html><head><title>Error</title></head><body>
<h2>Error</h2><p>${msg}</p><p>Please try the Slack command again.</p>
</body></html>`;

router.get('/github/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(HTML_ERROR('GitHub authorization was denied.'));
  }

  if (!code || !state) {
    return res.status(400).send(HTML_ERROR('Invalid callback parameters.'));
  }

  const stateData = consumeState(state);
  if (!stateData) {
    return res.status(400).send(HTML_ERROR('State is invalid or expired (10-minute TTL). Please retry.'));
  }

  let token;
  try {
    token = await exchangeCodeForToken(code);
  } catch (err) {
    console.error('OAuth token exchange failed:', err);
    return res.status(500).send(HTML_ERROR('Failed to obtain GitHub token.'));
  }

  // Respond to browser immediately; run deploy/hotfix in background
  res.send(HTML_SUCCESS);

  const { command, channelId } = stateData;

  if (command === 'deploy') {
    runDeploy({ token, groupName: stateData.groupName, releaseTitle: stateData.releaseTitle, channelId })
      .catch((err) => console.error('Background runDeploy error:', err));
  } else if (command === 'hotfix') {
    runHotfix({ token, projectName: stateData.projectName, releaseTitle: stateData.releaseTitle, channelId })
      .catch((err) => console.error('Background runHotfix error:', err));
  }
});

module.exports = router;

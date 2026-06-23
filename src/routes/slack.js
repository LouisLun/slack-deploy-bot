const express = require('express');
const verifySlack = require('../middleware/verifySlack');
const { createState } = require('../services/oauthState');
const { handleDeployConfig } = require('../handlers/deployConfig');
const { getInstallationToken } = require('../services/github');
const { runDeploy } = require('../handlers/deploy');
const { runHotfix } = require('../handlers/hotfix');

const router = express.Router();
router.use(verifySlack);

const USE_APP_MODE = process.env.GITHUB_AUTH_MODE === 'app';

function buildOAuthUrl(stateKey) {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    state: stateKey,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

function getBotToken() {
  const privateKey = (process.env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return getInstallationToken(
    process.env.GITHUB_APP_ID,
    privateKey,
    process.env.GITHUB_INSTALLATION_ID
  );
}

router.post('/deploy', (req, res) => {
  const { text, channel_id, user_id } = req.body;
  const parts = (text || '').trim().replace(/`/g, '').split(/\s+/);
  const groupName = parts[0];
  const releaseTitle = parts.slice(1).join(' ');

  if (!groupName || !releaseTitle) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/deploy <group-name> <release title>`' });
  }

  if (USE_APP_MODE) {
    res.json({ response_type: 'ephemeral', text: `Starting deployment of group *${groupName}*... Check Slack for updates.` });
    getBotToken()
      .then((token) => runDeploy({ token, groupName, releaseTitle, userId: user_id, channelId: channel_id }))
      .catch((err) => console.error('Background deploy error:', err));
    return;
  }

  const key = createState({ command: 'deploy', groupName, releaseTitle, channelId: channel_id, userId: user_id });
  const url = buildOAuthUrl(key);

  return res.json({
    response_type: 'ephemeral',
    text: `Authorize GitHub to deploy group *${groupName}*: <${url}|Click here to authorize>`,
  });
});

router.post('/hotfix', (req, res) => {
  const { text, channel_id, user_id } = req.body;
  const parts = (text || '').trim().replace(/`/g, '').split(/\s+/);
  const projectName = parts[0];
  const releaseTitle = parts.slice(1).join(' ');

  if (!projectName || !releaseTitle) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/hotfix <project-name> <release title>`' });
  }

  if (USE_APP_MODE) {
    res.json({ response_type: 'ephemeral', text: `Starting hotfix of *${projectName}*... Check Slack for updates.` });
    getBotToken()
      .then((token) => runHotfix({ token, projectName, releaseTitle, userId: user_id, channelId: channel_id }))
      .catch((err) => console.error('Background hotfix error:', err));
    return;
  }

  const key = createState({ command: 'hotfix', projectName, releaseTitle, channelId: channel_id, userId: user_id });
  const url = buildOAuthUrl(key);

  return res.json({
    response_type: 'ephemeral',
    text: `Authorize GitHub to hotfix *${projectName}*: <${url}|Click here to authorize>`,
  });
});

router.post('/deploy-config', async (req, res) => {
  const subcommand = ((req.body.text || '').trim()).toLowerCase();

  try {
    const result = await handleDeployConfig(subcommand);
    return res.json({ response_type: 'ephemeral', ...result });
  } catch (err) {
    return res.json({ response_type: 'ephemeral', text: `Error reading config: ${err.message}` });
  }
});

module.exports = router;

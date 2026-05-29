const express = require('express');
const verifySlack = require('../middleware/verifySlack');
const { createState } = require('../services/oauthState');
const { handleDeployConfig } = require('../handlers/deployConfig');

const router = express.Router();
router.use(verifySlack);

function buildOAuthUrl(stateKey) {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    scope: 'repo',
    state: stateKey,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

router.post('/deploy', (req, res) => {
  const { text, channel_id, user_id } = req.body;
  const groupName = (text || '').trim().replace(/`/g, '');

  if (!groupName) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/deploy <group-name>`' });
  }

  const key = createState({ command: 'deploy', groupName, channelId: channel_id, userId: user_id });
  const url = buildOAuthUrl(key);

  return res.json({
    response_type: 'ephemeral',
    text: `Authorize GitHub to deploy group *${groupName}*: <${url}|Click here to authorize>`,
  });
});

router.post('/hotfix', (req, res) => {
  const { text, channel_id, user_id } = req.body;
  const projectName = (text || '').trim().replace(/`/g, '');

  if (!projectName) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/hotfix <project-name>`' });
  }

  const key = createState({ command: 'hotfix', projectName, channelId: channel_id, userId: user_id });
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

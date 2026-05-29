const { WebClient } = require('@slack/web-api');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function postMessage(channel, text) {
  return client.chat.postMessage({ channel, text, unfurl_links: false });
}

async function postEphemeral(channel, user, text) {
  return client.chat.postEphemeral({ channel, user, text });
}

module.exports = { postMessage, postEphemeral };

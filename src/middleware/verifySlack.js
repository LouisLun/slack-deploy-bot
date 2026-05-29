const crypto = require('crypto');

function verifySlack(req, res, next) {
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  if (!signature || !timestamp) {
    return res.status(401).json({ error: 'Missing Slack signature headers' });
  }

  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
    return res.status(401).json({ error: 'Request timestamp expired' });
  }

  const sigBase = `v0:${timestamp}:${req.rawBody}`;
  const computed = `v0=${crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBase)
    .digest('hex')}`;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch {
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  next();
}

module.exports = verifySlack;

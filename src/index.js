const express = require('express');
const slackRoutes = require('./routes/slack');
const authRoutes = require('./routes/auth');

const app = express();

app.use(
  '/slack',
  express.urlencoded({
    extended: true,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.use('/auth', express.json());

app.use('/slack', slackRoutes);
app.use('/auth', authRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

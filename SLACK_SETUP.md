# Slack App Setup

---

## 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From scratch**.
3. Enter an **App Name** (e.g. `Deploy Bot`) and select your workspace.
4. Click **Create App**.

---

## 2. Configure Slash Commands

Go to **Slash Commands** in the left sidebar and create three commands:

### `/deploy`

| Field | Value |
|---|---|
| Command | `/deploy` |
| Request URL | `https://YOUR_CLOUD_RUN_URL/slack/deploy` |
| Short Description | `Deploy a group to production` |
| Usage Hint | `<group-name>` |

### `/hotfix`

| Field | Value |
|---|---|
| Command | `/hotfix` |
| Request URL | `https://YOUR_CLOUD_RUN_URL/slack/hotfix` |
| Short Description | `Deploy a hotfix for a project` |
| Usage Hint | `<project-name>` |

### `/deploy-config`

| Field | Value |
|---|---|
| Command | `/deploy-config` |
| Request URL | `https://YOUR_CLOUD_RUN_URL/slack/deploy-config` |
| Short Description | `View deploy configuration` |
| Usage Hint | `list` |

---

## 3. Configure OAuth Scopes

Go to **OAuth & Permissions** → **Scopes** → **Bot Token Scopes** and add:

| Scope | Reason |
|---|---|
| `chat:write` | Post messages to channels |
| `chat:write.public` | Post to channels the bot hasn't joined |
| `commands` | Respond to slash commands (added automatically) |

---

## 4. Install the App to Your Workspace

1. Go to **OAuth & Permissions** → click **Install to Workspace**.
2. Authorize the requested permissions.
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → this is `SLACK_BOT_TOKEN`.

---

## 5. Obtain SLACK_SIGNING_SECRET

1. Go to **Basic Information** → **App Credentials**.
2. Copy **Signing Secret** → this is `SLACK_SIGNING_SECRET`.

---

## 6. Invite the Bot to Channels

The bot must be a member of any channel where it will post deployment updates:

```
/invite @Deploy Bot
```

Or invite via the channel's **Integrations** → **Add apps** menu.

---

## 7. Enable Socket Mode (optional)

Not required for Cloud Run deployments. The app uses HTTP endpoints directly.

---

## Summary of Values Needed

| Env Var | Where to Find |
|---|---|
| `SLACK_SIGNING_SECRET` | Basic Information → App Credentials → Signing Secret |
| `SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`) |

# slack-deploy-bot

A Node.js HTTP server that handles Slack Slash Commands and triggers GitHub Actions workflows for deployment. Designed to run on Google Cloud Run.

## Features

- `/deploy <group>` — deploys a group of projects in ordered steps, with parallel execution within each step
- `/hotfix <project>` — deploys a single project's hotfix branch
- `/deploy-config list` — lists current deployment configuration
- GitHub OAuth per-user authorization — tokens are never stored
- Deploy config loaded from GCS or inline JSON (via environment variable)
- Real-time Slack progress updates throughout deployment

## Quick Start

```bash
docker run -p 8080:8080 \
  -e SLACK_SIGNING_SECRET=... \
  -e SLACK_BOT_TOKEN=... \
  -e GITHUB_CLIENT_ID=... \
  -e GITHUB_CLIENT_SECRET=... \
  -e DEPLOY_CONFIG_JSON='{"groups":{...},"projects":{...}}' \
  coffeesouffle/slack-deploy-bot
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Yes | Slack App signing secret |
| `SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (`xoxb-…`) |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `DEPLOY_CONFIG_JSON` | One of two | Full deploy config as JSON string |
| `GCS_BUCKET_NAME` | One of two | GCS bucket storing the config file |
| `GCS_CONFIG_FILE_PATH` | One of two | Config file path inside the bucket |
| `PORT` | No | HTTP port (default: `8080`) |

## Deploy Config Format

```json
{
  "groups": {
    "production": [
      {
        "step": 1,
        "projects": [
          { "name": "api",     "repo": "myorg/api",     "workflows": ["release-cd.yml"] },
          { "name": "console", "repo": "myorg/console", "workflows": ["release-cd.yml"] }
        ]
      },
      {
        "step": 2,
        "projects": [
          { "name": "website", "repo": "myorg/website", "workflows": ["release-cd.yml"] }
        ]
      }
    ]
  },
  "projects": {
    "api":     { "repo": "myorg/api",     "workflows": ["release-cd.yml"] },
    "console": { "repo": "myorg/console", "workflows": ["release-cd.yml"] },
    "website": { "repo": "myorg/website", "workflows": ["release-cd.yml"] }
  }
}
```

## Source

[github.com/LouisLun/slack-deploy-bot](https://github.com/LouisLun/slack-deploy-bot)

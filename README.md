# slack-deploy-bot

A Node.js HTTP server deployed on Google Cloud Run that handles Slack Slash Commands and triggers GitHub Actions workflows for deployment.

---

## Environment Variables

| Variable | Description |
|---|---|
| `SLACK_SIGNING_SECRET` | Found in Slack App → Basic Information → App Credentials |
| `SLACK_BOT_TOKEN` | `xoxb-…` token from Slack App → OAuth & Permissions |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `GCS_BUCKET_NAME` | GCS bucket that stores the config file |
| `GCS_CONFIG_FILE_PATH` | Path inside the bucket, e.g. `deploy-config.json` |
| `PORT` | (optional) defaults to `8080` |

---

## GCS Config File Format

The config file is JSON stored in GCS. It is read fresh on every request; no caching.

```json
{
  "groups": {
    "production": [
      {
        "step": 1,
        "projects": [
          { "name": "restful",  "repo": "myorg/restful",  "workflows": ["release-cd.yml"] },
          { "name": "wms",      "repo": "myorg/wms",      "workflows": ["release-cd.yml", "notify.yml"] },
          { "name": "console",  "repo": "myorg/console",  "workflows": ["release-cd.yml"] }
        ]
      },
      {
        "step": 2,
        "projects": [
          { "name": "website",  "repo": "myorg/website",  "workflows": ["release-cd.yml"] }
        ]
      }
    ]
  },
  "projects": {
    "restful":  { "repo": "myorg/restful",  "workflows": ["release-cd.yml"] },
    "wms":      { "repo": "myorg/wms",      "workflows": ["release-cd.yml", "notify.yml"] },
    "console":  { "repo": "myorg/console",  "workflows": ["release-cd.yml"] },
    "website":  { "repo": "myorg/website",  "workflows": ["release-cd.yml"] }
  }
}
```

- `groups` is used by `/deploy`. Each group contains ordered steps.
- `projects` is used by `/hotfix`. Flat map of project name → repo + workflows.
- The config is **read-only** from the app's perspective. Modify it directly in GCS.

---

## Step Flow Logic (`/deploy`)

```
/deploy production
  │
  ├─ Step 1 (concurrent)
  │   ├─ restful:  release-cd.yml ──► wait ──► release
  │   ├─ wms:      release-cd.yml ──► wait ──► notify.yml ──► wait ──► release
  │   └─ console:  release-cd.yml ──► wait ──► release
  │
  └─ Step 2 (starts only after Step 1 fully completes)
      └─ website:  release-cd.yml ──► wait ──► release
```

- Projects **within the same step** are triggered in parallel.
- Workflows **within the same project** run sequentially (next starts only after previous completes successfully).
- A failed workflow aborts remaining workflows for that project and blocks the next step.
- Projects with no open PR labelled `production` (case-insensitive) are **skipped** and reported in Slack.

---

## Hotfix Usage (`/hotfix`)

```
/hotfix <project-name>
```

1. Looks up `<project-name>` in `config.projects`.
2. Finds the most recently updated open PR labelled `hotfix` (case-insensitive).
3. Runs that project's workflows sequentially.
4. Creates a GitHub Release on success.

Example:
```
/hotfix wms
```

---

## Version Numbering

Each project's version is computed independently:

- Fetches the latest GitHub Release tag for that repo.
- Parses it as `vMAJOR.MINOR.PATCH` and returns `vMAJOR.MINOR.(PATCH+1)`.
- If no release exists yet, starts at `v0.0.1`.

---

## Cloud Run Deployment

### Prerequisites

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com storage.googleapis.com
```

### Build and deploy

```bash
PROJECT_ID=$(gcloud config get-value project)
IMAGE=gcr.io/$PROJECT_ID/slack-deploy-bot

# Build
docker build -t $IMAGE .
docker push $IMAGE

# Deploy
gcloud run deploy slack-deploy-bot \
  --image $IMAGE \
  --platform managed \
  --region asia-east1 \
  --allow-unauthenticated \
  --timeout 3600 \
  --set-env-vars \
    SLACK_SIGNING_SECRET=..., \
    SLACK_BOT_TOKEN=..., \
    GITHUB_CLIENT_ID=..., \
    GITHUB_CLIENT_SECRET=..., \
    GCS_BUCKET_NAME=..., \
    GCS_CONFIG_FILE_PATH=deploy-config.json
```

> **Timeout**: Set to `3600` seconds. Deploying across multiple steps with slow workflows can take a long time. The browser callback returns immediately; the long-running work runs as a background async task within the same Cloud Run instance.

### Service Account Permissions

The Cloud Run service account needs:

```bash
# Read GCS config
gsutil iam ch serviceAccount:SA_EMAIL:objectViewer gs://YOUR_BUCKET
```

GitHub access is obtained per-user via OAuth (token is never stored).

---

## GitHub OAuth App Setup

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name**: `Slack Deploy Bot`
   - **Homepage URL**: your Cloud Run service URL
   - **Authorization callback URL**: `https://YOUR_CLOUD_RUN_URL/auth/github/callback`
3. Click **Register application**.
4. Copy **Client ID** → `GITHUB_CLIENT_ID`.
5. Generate a **Client Secret** → `GITHUB_CLIENT_SECRET`.

### Required GitHub Scope

The bot requests the `repo` scope, which covers:
- Reading pull requests and releases
- Triggering `workflow_dispatch`
- Creating releases

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/slack/deploy` | Handles `/deploy <group>` slash command |
| `POST` | `/slack/hotfix` | Handles `/hotfix <project>` slash command |
| `POST` | `/slack/deploy-config` | Handles `/deploy-config list` slash command |
| `GET` | `/auth/github/callback` | GitHub OAuth callback |
| `GET` | `/health` | Health check |

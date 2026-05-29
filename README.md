# slack-deploy-bot

A Node.js HTTP server deployed on Google Cloud Run that handles Slack Slash Commands and triggers GitHub Actions workflows for deployment.

---

## Using This Template

This repository is a [GitHub Template](https://github.com/LouisLun/slack-deploy-bot). To use it for your own organization:

1. Click **Use this template** → **Create a new repository**
2. Select owner, name the repo, set visibility
3. Follow the Setup Order below in your new repo

Each organization gets a fully independent repo with no link back to this template.

---

## Setup Order

> Cloud Run URL is required for both GitHub OAuth App and Slack slash command URLs. Do a first deploy with placeholder secrets to obtain the URL, then complete the remaining setup.

```
Step 1 — GCP Infrastructure
  ├─ Enable required APIs (see Cloud Run Deployment → Prerequisites)
  ├─ Create GCS bucket and upload deploy-config.json
  └─ Set up Workload Identity Federation + Service Account (see Setting up WIF)

Step 2 — GitHub Actions (infra vars only)
  └─ Add repo Secrets: WIF_PROVIDER, WIF_SERVICE_ACCOUNT,
                       DOCKERHUB_USERNAME, DOCKERHUB_TOKEN
     Add repo Variables: GCP_PROJECT, GCP_REGION,
                         CLOUD_RUN_SERVICE, GCS_BUCKET_NAME, GCS_CONFIG_FILE_PATH
     (Leave app secrets empty for now)

Step 3 — Activate Cloud Run deploy workflow
  └─ cp .github/workflows/deploy-cloudrun.yml.example \
        .github/workflows/deploy-cloudrun.yml
     git add . && git commit -m "ci: add Cloud Run deploy workflow" && git push

Step 4 — First Deploy (to obtain Cloud Run URL)
  ├─ GitHub → Actions → Build and Push to Docker Hub → Run workflow
  └─ GitHub → Actions → Deploy to Cloud Run → Run workflow
     Note the URL: https://slack-deploy-bot-xxxx-xx.a.run.app

Step 5 — GitHub OAuth App Setup
  └─ Set callback URL: https://YOUR_CLOUD_RUN_URL/auth/github/callback
     Obtain: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET

Step 6 — Slack App Setup  (see SLACK_SETUP.md)
  └─ Set slash command Request URL: https://YOUR_CLOUD_RUN_URL/slack/{deploy,hotfix,deploy-config}
     Obtain: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN

Step 7 — Fill remaining GitHub Actions Secrets
  └─ SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN,
     GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET

Step 8 — Redeploy to apply all environment variables
  └─ GitHub → Actions → Deploy to Cloud Run → Run workflow
```

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
  ├─ Step 1 (all projects concurrent)
  │   ├─ restful:  release-cd.yml ─────────────► wait ──► release
  │   ├─ wms:      release-cd.yml ──► wait ──┐
  │   │            notify.yml     ──► wait ──┴─► release
  │   └─ console:  release-cd.yml ─────────────► wait ──► release
  │
  └─ Step 2 (starts only after Step 1 fully completes)
      └─ website:  release-cd.yml ─────────────► wait ──► release
```

- Projects **within the same step** are triggered in parallel.
- Workflows **within the same project** are also triggered in parallel (all fire simultaneously, wait for all to complete).
- A failed workflow aborts the release for that project and blocks the next step.
- Projects with no open PR labelled `production` (case-insensitive) are **skipped** and reported in Slack.

---

## Hotfix Usage (`/hotfix`)

```
/hotfix <project-name>
```

1. Looks up `<project-name>` in `config.projects`.
2. Finds the most recently updated open PR labelled `hotfix` (case-insensitive).
3. Triggers all of that project's workflows in parallel, waits for all to complete.
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

## GitHub Actions Secrets & Variables

Configure these in **GitHub repo → Settings → Secrets and variables → Actions**.

### Secrets

| Name | Description |
|---|---|
| `WIF_PROVIDER` | Workload Identity Federation provider resource name<br>`projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `WIF_SERVICE_ACCOUNT` | Service account email used for deployment<br>`deploy-bot@<project-id>.iam.gserviceaccount.com` |
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub access token (Settings → Security → Access Tokens) |
| `SLACK_SIGNING_SECRET` | Slack App signing secret |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-…`) |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |

### Variables (vars)

| Name | Example | Description |
|---|---|---|
| `GCP_PROJECT` | `my-project-id` | GCP project ID |
| `GCP_REGION` | `asia-east1` | Cloud Run region |
| `CLOUD_RUN_SERVICE` | `slack-deploy-bot` | Cloud Run service name |
| `GCS_BUCKET_NAME` | `my-bucket` | GCS bucket storing the deploy config |
| `GCS_CONFIG_FILE_PATH` | `deploy-config.json` | Config file path inside the bucket |

The deploy workflow pushes the image to Docker Hub as:
```
<DOCKERHUB_USERNAME>/slack-deploy-bot:<sha>
```

Secrets and variables are injected into Cloud Run as environment variables on every deploy.

### Setting up Workload Identity Federation

```bash
PROJECT_ID=my-project-id
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
POOL=github-pool
PROVIDER=github-provider
SA=deploy-bot

# Create service account
gcloud iam service-accounts create $SA --project=$PROJECT_ID

# Grant roles needed by the SA
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# Create Workload Identity Pool
gcloud iam workload-identity-pools create $POOL \
  --location=global \
  --project=$PROJECT_ID

# Create provider (restrict to your repo)
gcloud iam workload-identity-pools providers create-oidc $PROVIDER \
  --location=global \
  --workload-identity-pool=$POOL \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='<YOUR_GITHUB_ORG>/slack-deploy-bot'" \
  --project=$PROJECT_ID

# Allow GitHub Actions to impersonate the SA
gcloud iam service-accounts add-iam-policy-binding \
  $SA@$PROJECT_ID.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/<YOUR_GITHUB_ORG>/slack-deploy-bot" \
  --project=$PROJECT_ID

# Print values to put in GitHub Secrets
echo "WIF_PROVIDER: projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "WIF_SERVICE_ACCOUNT: $SA@$PROJECT_ID.iam.gserviceaccount.com"
```

---

## Cloud Run Deployment

### Prerequisites

```bash
gcloud services enable \
  run.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com
```

### Deploy via GitHub Actions

Two separate workflows handle build and deploy:

**Step 1 — Build and push image**

Go to **GitHub → Actions → Build and Push to Docker Hub → Run workflow**.

Builds the Docker image and pushes `<DOCKERHUB_USERNAME>/slack-deploy-bot:<sha>` and `:latest` to Docker Hub.

**Step 2 — Deploy to Cloud Run**

A `.github/workflows/deploy-cloudrun.yml.example` is included as a starting point. To activate it:

```bash
cp .github/workflows/deploy-cloudrun.yml.example .github/workflows/deploy-cloudrun.yml
git add .github/workflows/deploy-cloudrun.yml
git commit -m "ci: add Cloud Run deploy workflow"
git push
```

Then go to **GitHub → Actions → Deploy to Cloud Run → Run workflow**.

You can optionally specify an image tag to deploy (defaults to `latest`).

After the first deploy, obtain the Cloud Run URL via:

```bash
gcloud run services describe slack-deploy-bot \
  --region asia-east1 \
  --format='value(status.url)'
```

Or from **GCP Console → Cloud Run → slack-deploy-bot → URL**.

> The URL is permanent — it does not change between redeployments as long as the service name and region remain the same. Use this URL for the GitHub OAuth App callback and Slack slash command Request URLs.

### Manual deploy (without GitHub Actions)

```bash
DOCKERHUB_USERNAME=your-dockerhub-username
REGION=asia-east1
IMAGE=$DOCKERHUB_USERNAME/slack-deploy-bot

docker build -t $IMAGE .
docker push $IMAGE

gcloud run deploy slack-deploy-bot \
  --image $IMAGE \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --timeout 3600 \
  --min-instances 0 \
  --max-instances 3 \
  --concurrency 10 \
  --set-env-vars "SLACK_SIGNING_SECRET=...,SLACK_BOT_TOKEN=...,GITHUB_CLIENT_ID=...,GITHUB_CLIENT_SECRET=...,GCS_BUCKET_NAME=...,GCS_CONFIG_FILE_PATH=deploy-config.json"
```

> **Timeout**: Set to `3600` seconds. The browser OAuth callback returns immediately; the long-running workflow polling runs as a background async task within the same Cloud Run instance.
>
> **Scaling**: `--min-instances=0` means no idle cost when the bot is not in use. `--max-instances=3` caps scaling, `--concurrency=10` limits concurrent requests per instance.

### Service Account Permissions (Cloud Run runtime)

The Cloud Run service account needs read access to the GCS config bucket:

```bash
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

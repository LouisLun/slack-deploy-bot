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
  │   ├─ restful:  release-cd.yml ──► wait ──┐
  │   │                                      ├─► release
  │   ├─ wms:      release-cd.yml ──► wait ──┤
  │   │            notify.yml    ──► wait ──┘
  │   └─ console:  release-cd.yml ──► wait ──► release
  │
  └─ Step 2 (starts only after Step 1 fully completes)
      └─ website:  release-cd.yml ──► wait ──► release
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
| `SLACK_SIGNING_SECRET` | Slack App signing secret |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-…`) |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |

### Variables (vars)

| Name | Example | Description |
|---|---|---|
| `GCP_PROJECT` | `my-project-id` | GCP project ID |
| `AR_REGION` | `asia-east1` | Artifact Registry and Cloud Run region |
| `AR_REPOSITORY` | `slack-deploy-bot` | Artifact Registry Docker repository name |
| `CLOUD_RUN_SERVICE` | `slack-deploy-bot` | Cloud Run service name |
| `GCS_BUCKET_NAME` | `my-bucket` | GCS bucket storing the deploy config |
| `GCS_CONFIG_FILE_PATH` | `deploy-config.json` | Config file path inside the bucket |

The deploy workflow constructs the image path as:
```
<AR_REGION>-docker.pkg.dev/<GCP_PROJECT>/<AR_REPOSITORY>/slack-deploy-bot
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
  --role="roles/artifactregistry.writer"
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

### Creating the Artifact Registry repository

```bash
gcloud artifacts repositories create slack-deploy-bot \
  --repository-format=docker \
  --location=asia-east1 \
  --project=$PROJECT_ID
```

---

## Cloud Run Deployment

### Prerequisites

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com
```

### Deploy via GitHub Actions

Go to **GitHub → Actions → Deploy to Cloud Run → Run workflow**.

The workflow builds the Docker image, pushes it to Artifact Registry, and deploys to Cloud Run.

### Manual deploy (without GitHub Actions)

```bash
PROJECT_ID=my-project-id
REGION=asia-east1
IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/slack-deploy-bot/slack-deploy-bot

docker build -t $IMAGE .
docker push $IMAGE

gcloud run deploy slack-deploy-bot \
  --image $IMAGE \
  --platform managed \
  --region $REGION \
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

> **Timeout**: Set to `3600` seconds. The browser OAuth callback returns immediately; the long-running workflow polling runs as a background async task within the same Cloud Run instance.

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

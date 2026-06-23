# slack-deploy-bot

A Node.js HTTP server deployed on Google Cloud Run that handles Slack Slash Commands and triggers GitHub Actions workflows for deployment.

---

## Setup Order

> Cloud Run URL is required for both GitHub App and Slack slash command URLs. Do a first deploy with placeholder secrets to obtain the URL, then complete the remaining setup.

```
Step 1 — GCP Infrastructure
  ├─ Enable required APIs (see Cloud Run Deployment → Prerequisites)
  ├─ Set up Workload Identity Federation + Service Account (see Setting up WIF)
  └─ (GCS provider only) Create GCS bucket and upload deploy-config.json

Step 2 — GitHub Actions (infra vars only)
  └─ Add repo Secrets: WIF_PROVIDER, WIF_SERVICE_ACCOUNT,
                       DOCKERHUB_USERNAME, DOCKERHUB_TOKEN
     Add repo Variables: GCP_PROJECT, GCP_REGION,
                         CLOUD_RUN_SERVICE, GCS_BUCKET_NAME, GCS_CONFIG_FILE_PATH
     (Leave app secrets empty for now)

Step 3 — Add Cloud Run deploy workflow
  └─ Copy deploy-cloudrun.yml from slack-deploy-bot-example repo:
     https://github.com/LouisLun/slack-deploy-bot-example
     Place at .github/workflows/deploy-cloudrun.yml and push

Step 4 — First Deploy (to obtain Cloud Run URL)
  ├─ GitHub → Releases → Create a new release → Publish
  │   (triggers Build and Push to Docker Hub automatically)
  └─ GitHub → Actions → Deploy to Cloud Run → Run workflow
     Note the URL: https://slack-deploy-bot-xxxx-xx.a.run.app

Step 5 — GitHub App Setup
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
| `GCS_BUCKET_NAME` | GCS bucket that stores the config file |
| `GCS_CONFIG_FILE_PATH` | Path inside the bucket, e.g. `deploy-config.json` |
| `PORT` | (optional) defaults to `8080` |

### GitHub Auth Mode

Set `GITHUB_AUTH_MODE` to choose how the bot authenticates with GitHub:

**`oauth` (default)** — each user authorizes via GitHub OAuth before deploying. API calls are made as the individual user.

| Variable | Description |
|---|---|
| `GITHUB_AUTH_MODE` | Set to `oauth` or omit |
| `GITHUB_CLIENT_ID` | GitHub App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret |

**`app`** — bot uses a GitHub App installation token. No per-user OAuth required; API calls are made as the bot.

| Variable | Description |
|---|---|
| `GITHUB_AUTH_MODE` | Set to `app` |
| `GITHUB_APP_ID` | GitHub App ID (found on the App settings page) |
| `GITHUB_PRIVATE_KEY` | GitHub App private key (full PEM content, newlines as `\n`) |
| `GITHUB_INSTALLATION_ID` | Installation ID (from the URL after installing the App) |

---

## Config Providers

The app reads the deploy config on every request. Two providers are supported — set one:

| Provider | Env Var | When to Use |
|---|---|---|
| Inline JSON | `DEPLOY_CONFIG_JSON` | Simpler setup; config stored as a GitHub secret |
| GCS | `GCS_BUCKET_NAME` + `GCS_CONFIG_FILE_PATH` | Config managed outside the repo; easier to update without redeploying |

`DEPLOY_CONFIG_JSON` takes priority. If set, GCS vars are ignored.

**Inline JSON example** (`DEPLOY_CONFIG_JSON` secret value):
```json
{"groups":{"production":[{"step":1,"projects":[{"name":"restful","repo":"myorg/restful","workflows":["release-cd.yml"]},{"name":"frontend","repo":"myorg/frontend","mergeOnly":true}]}]},"projects":{"restful":{"repo":"myorg/restful","workflows":["release-cd.yml"]},"frontend":{"repo":"myorg/frontend","mergeOnly":true}}}
```

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
          { "name": "console",  "repo": "myorg/console",  "workflows": ["release-cd.yml"] },
          { "name": "frontend", "repo": "myorg/frontend", "mergeOnly": true }
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
    "website":  { "repo": "myorg/website",  "workflows": ["release-cd.yml"] },
    "frontend": { "repo": "myorg/frontend", "mergeOnly": true }
  }
}
```

- `groups` is used by `/deploy`. Each group contains ordered steps.
- `projects` is used by `/hotfix`. Flat map of project name → repo + workflows.
- `mergeOnly: true` — merge the PR and stop. No tag, no workflow trigger, no GitHub Release. Use for projects that auto-deploy on merge (e.g. Cloudflare Pages).
- The config is **read-only** from the app's perspective. Modify it directly in GCS.

---

## Deploy Usage (`/deploy`)

```
/deploy <group-name> <release title>
```

The release title is used as the GitHub Release name and shown in the Slack start message alongside the operator's mention.

Example:
```
/deploy production Fix checkout flow
```

## Step Flow Logic (`/deploy`)

```
/deploy production Fix checkout flow
  │
  ├─ Step 1 (all projects concurrent)
  │   ├─ restful:  merge PR ──► tag v1.0.1 ──► release-cd.yml ──► wait ──► release "Fix checkout flow"
  │   ├─ wms:      merge PR ──► tag v1.0.1 ──► release-cd.yml ──► wait ──┐
  │   │                                        notify.yml     ──► wait ──┴─► release "Fix checkout flow"
  │   ├─ console:  merge PR ──► tag v1.0.1 ──► release-cd.yml ──► wait ──► release "Fix checkout flow"
  │   └─ frontend: merge PR ──► (done, auto-deploys via Cloudflare)
  │
  └─ Step 2 (starts only after Step 1 fully completes)
      └─ website:  merge PR ──► tag v1.0.1 ──► release-cd.yml ──► wait ──► release "Fix checkout flow"
```

- Projects **within the same step** are triggered in parallel.
- Per project (normal): merge PR → create version tag on merge commit → trigger all workflows in parallel on that tag → wait for all to complete → create GitHub Release with the provided release title.
- Per project (`mergeOnly: true`): merge PR only — no tag, no workflow, no release.
- Workflows are triggered via `workflow_dispatch` with the version tag as ref (visible in GitHub Actions UI).
- Each workflow completion message includes a direct link to the GitHub Actions run.
- A failed workflow deletes the version tag and aborts the release for that project, blocking the next step.
- Projects with no open PR labelled `production` (case-insensitive) are **skipped** and reported in Slack.

---

## Hotfix Usage (`/hotfix`)

```
/hotfix <project-name> <release title>
```

The release title is used as the GitHub Release name and shown in the Slack start message alongside the operator's mention.

1. Looks up `<project-name>` in `config.projects`.
2. Finds the most recently updated open PR labelled `hotfix` (case-insensitive).
3. Merges the PR.
4. If `mergeOnly: true` — stops here (auto-deploys externally).
5. Creates a version tag on the merge commit.
6. Triggers all of that project's workflows in parallel on the version tag, waits for all to complete.
7. On failure: deletes the version tag and reports the GitHub Actions run link in Slack.
8. On success: creates a GitHub Release with the provided release title.

Example:
```
/hotfix wms Fix order sync bug
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
| `DEPLOY_CONFIG_JSON` | (optional) Full deploy config JSON string — overrides GCS when set |
| `SLACK_SIGNING_SECRET` | Slack App signing secret |
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token (`xoxb-…`) |
| `GITHUB_CLIENT_ID` | GitHub App client ID (`oauth` mode) |
| `GITHUB_CLIENT_SECRET` | GitHub App client secret (`oauth` mode) |
| `GITHUB_AUTH_MODE` | Set to `app` to use bot identity instead of per-user OAuth |
| `GITHUB_APP_ID` | GitHub App ID (`app` mode) |
| `GITHUB_PRIVATE_KEY` | GitHub App private key PEM (`app` mode) |
| `GITHUB_INSTALLATION_ID` | GitHub App installation ID (`app` mode) |

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
<DOCKERHUB_USERNAME>/slack-deploy-bot:<release-tag>          # always
<DOCKERHUB_USERNAME>/slack-deploy-bot:latest                 # only when release is the latest non-prerelease
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

Go to **GitHub → Releases → Create a new release → Publish**.

This automatically triggers the `Build and Push to Docker Hub` workflow, which pushes `<DOCKERHUB_USERNAME>/slack-deploy-bot:<release-tag>` and `:latest` to Docker Hub.

**Step 2 — Deploy to Cloud Run**

Copy `deploy-cloudrun.yml` from [slack-deploy-bot-example](https://github.com/LouisLun/slack-deploy-bot-example) into `.github/workflows/` and push. Then go to **GitHub → Actions → Deploy to Cloud Run → Run workflow**.

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

## GitHub App Setup

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in:
   - **GitHub App name**: `Slack Deploy Bot`
   - **Homepage URL**: your Cloud Run service URL
   - **Callback URL**: `https://YOUR_CLOUD_RUN_URL/auth/github/callback`
   - **Webhook → Active**: uncheck
   - **Where can this GitHub App be installed?**: Only on this account
3. Set **Repository permissions**:
   - Actions: Read & Write
   - Contents: Read & Write
   - Metadata: Read (mandatory)
   - Pull requests: Read & Write
4. Click **Create GitHub App**.
5. Copy **Client ID** → `GITHUB_CLIENT_ID`.
6. Click **Generate a new client secret** → `GITHUB_CLIENT_SECRET`.
7. Go to **Install App** → Install on your account/org → select only the repos used in your deploy config.

> **Why GitHub App instead of OAuth App?** GitHub App permissions are granular — only Actions, Contents, and Pull Requests access is granted. OAuth App's `repo` scope also grants repository settings and collaboration invite management, which this bot does not need.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/slack/deploy` | Handles `/deploy <group> <release title>` slash command |
| `POST` | `/slack/hotfix` | Handles `/hotfix <project> <release title>` slash command |
| `POST` | `/slack/deploy-config` | Handles `/deploy-config list` slash command |
| `GET` | `/auth/github/callback` | GitHub OAuth callback |
| `GET` | `/health` | Health check |

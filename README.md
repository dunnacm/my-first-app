# Subtraction HUD

Subtraction HUD is a Flask-based math practice app built for fast keyboard-only subtraction drills, persistent history, and a dark HUD-style interface.

## Why this stack

I kept this as a Flask app instead of switching to Streamlit because the required UX is closer to a lightweight game interface than a dashboard:

- precise keyboard handling
- smoother per-problem and session timers
- clean control over separate exercise and statistics screens
- easier styling for the dark HUD layout

## Features

- Dark navy HUD-style interface with gold accents and geometric background textures
- Start screen, exercise screen, and end-of-session statistics screen
- Full 190-problem subtraction deck using all positive integer pairs where `1 <= B < A <= 20`
- Adaptive review using a persisted difficulty score
- Weak-problems-only mode based on saved history
- Per-problem timer and session timer
- Pause, restart, skip, and early-finish support
- Instant visual feedback for correct and incorrect responses
- Heat map covering all 190 subtraction pairs
- Progress-over-time chart across saved sessions
- Personal best average-time tracking
- Local SQLite persistence by default
- Optional cloud persistence with PostgreSQL through `DATABASE_URL`

## Important rules note

Your prompt contains one internal conflict:

- `B` ranging from `0` to `A - 1` produces 210 unique pairs
- the app is also described as a 190-problem deck

To keep the deck size at exactly 190, this app uses the positive-integer interpretation:

- `A` ranges from `1` to `20`
- `B` ranges from `1` to `A - 1`
- therefore `1 <= B < A <= 20`

## File structure

```text
subtraction-hud/
|-- app.py
|-- Procfile
|-- README.md
|-- render.yaml
|-- requirements.txt
|-- static/
|   |-- app.js
|   `-- styles.css
`-- templates/
    `-- index.html
```

## Local setup

### 1. Create and activate a virtual environment

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

### 2. Install dependencies

```powershell
pip install -r requirements.txt
```

### 3. Run the app

```powershell
python app.py
```

Then open `http://127.0.0.1:5000`.

## Data persistence

### Local development

If you do nothing, the app stores data in:

```text
instance/subtraction_hud.db
```

### Cloud deployment

Set a `DATABASE_URL` environment variable and the app will use PostgreSQL instead of local SQLite.

Example:

```text
postgresql://USER:PASSWORD@HOST:5432/postgres
```

The app automatically normalizes that URL for SQLAlchemy.

## Recommended free deployment

For this Flask build, the best fit is:

- Koyeb free web service for the app
- Supabase free Postgres for persistent history

Why:

- Streamlit Community Cloud is free, but it is designed for Streamlit apps, not Flask apps.
- Koyeb officially supports Flask deployments and currently offers a free instance.
- Supabase currently offers a free plan with up to two free projects, which is enough for this app's saved history.

## Deploy to Koyeb

### 1. Push this project to GitHub

Create a GitHub repository and push the code.

### 2. Create a free Supabase project

In Supabase:

- create a new project
- open the project settings
- copy the Postgres connection string

### 3. Create a Koyeb web service

In Koyeb:

1. Click **Create Service**
2. Choose **Web Service**
3. Connect your GitHub repository
4. Use the repository branch you want to deploy
5. Keep the build method as **Buildpack**
6. Use the run command:

```text
gunicorn --bind 0.0.0.0:$PORT app:app
```

7. Choose the free instance size

### 4. Add environment variables

In Koyeb, add:

- `DATABASE_URL` = your Supabase Postgres URL

### 5. Deploy

Koyeb will install the requirements and launch the app. On first start, the tables are created automatically.

## Optional Render deployment

This repo also includes a `render.yaml` and a compatible `gunicorn` command if you prefer Render. I am not recommending it as the primary free path here because Koyeb is the cleaner current free fit for a small Flask app.

## Spaced repetition behavior

The adaptive mode stores a `difficulty_score` for each subtraction pair. That score increases when a problem is:

- answered incorrectly
- skipped
- answered slowly

It decreases when a problem is answered correctly and quickly across consecutive attempts. That means strong facts gradually appear less often while weaker facts get pulled forward more aggressively.

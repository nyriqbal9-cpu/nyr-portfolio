# NYR Portfolio — Render deployment files

This package is intended to be copied into the ROOT of your existing GitHub
repository (`nyr-portfolio`).

## Files in this package

- `backend/app.py`: updated Flask app; its direct-run host defaults to
  `0.0.0.0`. The production start command uses Gunicorn.
- `render.yaml`: Render Blueprint configuration for one Python Web Service.
- `.python-version`: pins the Render Python runtime to 3.11.9.

## Important: keep your existing files

Do not delete or replace these existing project files:
- `backend/knowledge.py`
- `backend/requirements.txt`
- `index.html`
- `style.css`
- `script.js`
- `assets/`

Your existing `backend/requirements.txt` must include `gunicorn`.
The version currently in your GitHub repository already includes it.

## Render settings

Use the repository root as the Root Directory (leave Root Directory blank).

- Service type: Web Service
- Runtime: Python
- Build Command: `pip install -r backend/requirements.txt`
- Start Command: `gunicorn backend.app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 60`
- Health Check Path: `/api/health`

Environment variables to set in Render:
- `OPENROUTER_API_KEY` = your private OpenRouter API key
- `OPENROUTER_MODEL` = the model value that works in your local backend/.env
- `SERVE_FRONTEND` = `1`
- `TRUST_PROXY` = `1`
- `PYTHON_VERSION` = `3.11.9`

Do not upload your real `.env` file or paste your API key into GitHub.
The website and chatbot are served from the same Render domain, so the
frontend JavaScript can use the same-origin `/api/chat` and `/api/health`
routes; you do not need to set a separate frontend API URL or CORS origin.

## After copying these files into your project

From the project root in the VS Code terminal:

```powershell
git add backend/app.py render.yaml .python-version
git status
git commit -m "Prepare portfolio for Render deployment"
git push
```

Check `git status` before committing. Make sure no `.env` file is listed.

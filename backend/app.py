"""
NYR Assistant - Flask backend for Nayyar Iqbal's portfolio.

The browser never talks to OpenRouter directly. It sends the conversation to
POST /api/chat, this server adds the system prompt + API key (read from the
environment) and returns only the assistant's reply text.

Run locally:   python app.py   ->   http://127.0.0.1:5000
"""

import logging
import os
import re
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from backend.knowledge import SYSTEM_PROMPT

# --------------------------------------------------------------------------
# Configuration (all values come from environment variables / backend/.env)
# --------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
SITE_DIR = BASE_DIR.parent  # the portfolio folder (index.html, style.css, ...)
load_dotenv(BASE_DIR / ".env")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
PLACEHOLDERS = {"", "your_api_key_here", "your_preferred_model_here"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
MODEL = os.getenv("OPENROUTER_MODEL", "").strip()
SITE_URL = os.getenv("OPENROUTER_SITE_URL", "").strip()  # optional, shown on OpenRouter
APP_NAME = os.getenv("OPENROUTER_APP_NAME", "NYR Portfolio Assistant").strip()

DEFAULT_ORIGINS = (
    "http://127.0.0.1:5500,http://localhost:5500,"
    "http://127.0.0.1:5000,http://localhost:5000"
)
ALLOWED_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.getenv("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if o.strip()
}

RATE_PER_MINUTE = _int_env("RATE_LIMIT_PER_MINUTE", 15)
RATE_PER_HOUR = _int_env("RATE_LIMIT_PER_HOUR", 120)
MAX_USER_CHARS = 1000        # longest message a visitor can send
MAX_ASSISTANT_CHARS = 4000   # longest earlier reply accepted back in history
MAX_HISTORY = 12             # how many recent messages are sent to the model
MAX_REPLY_TOKENS = _int_env("MAX_REPLY_TOKENS", 600)
TIMEOUT = (5, 45)            # (connect, read) seconds for the OpenRouter call
SERVE_FRONTEND = os.getenv("SERVE_FRONTEND", "1") != "0"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nyr-assistant")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024  # reject huge request bodies
if os.getenv("TRUST_PROXY") == "1":  # set on hosts that sit behind a proxy (Render, etc.)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def is_configured() -> bool:
    return API_KEY not in PLACEHOLDERS and MODEL not in PLACEHOLDERS


# User-facing messages. Internal details are only ever written to the server log.
MSG_UNAVAILABLE = "The assistant is temporarily unavailable. Please try again in a little while."
MSG_BUSY = "The assistant is busy right now. Please try again in a moment."
MSG_TIMEOUT = "The assistant took too long to respond. Please try again."
MSG_BAD_REQUEST = "Sorry, I couldn't read that message. Please try again."
MSG_RATE = "You're sending messages very quickly. Please wait a moment and try again."


def error(message: str, status: int, **extra):
    return jsonify({"error": message, **extra}), status


# --------------------------------------------------------------------------
# Basic in-memory rate limiter (per client IP, sliding window)
# --------------------------------------------------------------------------
class RateLimiter:
    """Allows `per_minute` and `per_hour` requests per key. Resets on restart.
    For several server processes, replace with Redis (e.g. Flask-Limiter)."""

    def __init__(self, per_minute: int, per_hour: int):
        self.per_minute, self.per_hour = per_minute, per_hour
        self.hits = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key: str):
        """Return None if allowed, otherwise the seconds to wait."""
        now = time.time()
        with self.lock:
            if len(self.hits) > 5000:  # keep memory bounded
                for k in [k for k, d in self.hits.items() if not d or now - d[-1] > 3600]:
                    del self.hits[k]
            q = self.hits[key]
            while q and now - q[0] > 3600:
                q.popleft()
            last_minute = [t for t in q if now - t <= 60]
            if len(last_minute) >= self.per_minute:
                return max(1, int(60 - (now - last_minute[0])) + 1)
            if len(q) >= self.per_hour:
                return max(1, int(3600 - (now - q[0])) + 1)
            q.append(now)
            return None


limiter = RateLimiter(RATE_PER_MINUTE, RATE_PER_HOUR)


# --------------------------------------------------------------------------
# CORS + security headers
# --------------------------------------------------------------------------
@app.after_request
def add_headers(resp):
    origin = (request.headers.get("Origin") or "").rstrip("/")
    if request.path.startswith("/api/") and origin in ALLOWED_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Max-Age"] = "600"
        resp.headers["Vary"] = "Origin"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# --------------------------------------------------------------------------
# Request validation
# --------------------------------------------------------------------------
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def validate_messages(data):
    """Return (clean_messages, None) or (None, reason)."""
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return None, "messages must be a list"
    raw = data["messages"]
    if not raw or len(raw) > 100:
        return None, "invalid number of messages"

    clean = []
    for m in raw:
        if not isinstance(m, dict):
            return None, "invalid message"
        role, content = m.get("role"), m.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            return None, "invalid role or content"
        content = _CONTROL_CHARS.sub("", content).strip()
        limit = MAX_USER_CHARS if role == "user" else MAX_ASSISTANT_CHARS
        if not content or len(content) > limit:
            return None, "empty or too long"
        clean.append({"role": role, "content": content})

    if clean[-1]["role"] != "user":
        return None, "last message must be from the user"

    clean = clean[-MAX_HISTORY:]
    while clean and clean[0]["role"] != "user":  # some models need a user-first chat
        clean.pop(0)
    return clean, None


# --------------------------------------------------------------------------
# OpenRouter call
# --------------------------------------------------------------------------
_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def call_openrouter(messages):
    """Return (reply_text, None) or (None, (user_message, http_status))."""
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "X-Title": APP_NAME,
    }
    if SITE_URL:
        headers["HTTP-Referer"] = SITE_URL

    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, *messages],
        "temperature": 0.4,
        "max_tokens": MAX_REPLY_TOKENS,
    }

    try:
        r = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=TIMEOUT)
    except requests.Timeout:
        log.warning("OpenRouter request timed out")
        return None, (MSG_TIMEOUT, 504)
    except requests.RequestException as exc:
        log.warning("OpenRouter request failed: %s", type(exc).__name__)
        return None, (MSG_UNAVAILABLE, 502)

    if r.status_code != 200:
        log.warning("OpenRouter returned %s: %s", r.status_code, r.text[:300])
        if r.status_code == 429:
            return None, (MSG_BUSY, 503)
        if r.status_code in (401, 402, 403):
            log.error("Check OPENROUTER_API_KEY and your OpenRouter credits/limits.")
        if r.status_code in (400, 404):
            log.error("Check OPENROUTER_MODEL: the model name may be wrong or retired.")
        return None, (MSG_UNAVAILABLE, 503 if r.status_code < 500 else 502)

    try:
        body = r.json()
        if body.get("error"):  # OpenRouter can return an error inside a 200
            log.warning("OpenRouter error body: %s", str(body["error"])[:300])
            return None, (MSG_UNAVAILABLE, 502)
        text = body["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        log.warning("Unexpected OpenRouter response shape")
        return None, (MSG_UNAVAILABLE, 502)

    text = _THINK_BLOCK.sub("", text or "").strip()
    if not text:
        log.warning("OpenRouter returned an empty reply")
        return None, (MSG_UNAVAILABLE, 502)
    return text, None


# --------------------------------------------------------------------------
# API routes
# --------------------------------------------------------------------------
@app.get("/api/health")
def health():
    # `ready` only says whether the server is configured; no secrets are exposed.
    return jsonify({"status": "ok", "ready": is_configured()})


@app.route("/api/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":  # CORS preflight (headers added in after_request)
        return "", 204

    wait = limiter.check(request.remote_addr or "unknown")
    if wait is not None:
        resp = error(MSG_RATE, 429, retry_after=wait)
        resp[0].headers["Retry-After"] = str(wait)
        return resp

    data = request.get_json(silent=True)
    messages, problem = validate_messages(data)
    if problem:
        log.info("Rejected request: %s", problem)
        return error(MSG_BAD_REQUEST, 400)

    if not is_configured():
        log.error("OPENROUTER_API_KEY / OPENROUTER_MODEL are not set in backend/.env")
        return error(MSG_UNAVAILABLE, 503)

    reply, failure = call_openrouter(messages)
    if failure:
        return error(*failure)
    return jsonify({"reply": reply})


# --------------------------------------------------------------------------
# JSON errors for the API, and (optional) serving the portfolio itself so that
# `python app.py` alone is enough for local testing. Only an allow-list of
# files is served, so backend/.env and the Python code are never exposed.
# --------------------------------------------------------------------------
@app.errorhandler(404)
@app.errorhandler(405)
def not_found(_e):
    if request.path.startswith("/api/"):
        return error("Not found.", 404)
    return "Not found", 404


@app.errorhandler(413)
def too_large(_e):
    return error(MSG_BAD_REQUEST, 413)


@app.errorhandler(Exception)
def unexpected(exc):
    if isinstance(exc, HTTPException):  # e.g. 400/414: keep the real status code
        if request.path.startswith("/api/"):
            return error(MSG_BAD_REQUEST, exc.code or 400)
        return exc
    log.exception("Unhandled error: %s", exc)
    if request.path.startswith("/api/"):
        return error(MSG_UNAVAILABLE, 500)
    return "Something went wrong.", 500


PUBLIC_FILES = {"index.html", "style.css", "script.js"}

if SERVE_FRONTEND:

    @app.get("/")
    def index():
        return send_from_directory(SITE_DIR, "index.html")

    @app.get("/<path:name>")
    def site_file(name):
        if name in PUBLIC_FILES:
            return send_from_directory(SITE_DIR, name)
        abort(404)

    @app.get("/assets/<path:name>")
    def site_asset(name):
        return send_from_directory(SITE_DIR / "assets", name)  # blocks path traversal


if __name__ == "__main__":
    if not is_configured():
        log.warning("Not configured yet: copy .env.example to .env and fill in your key and model.")
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=_int_env("PORT", 5000),
        debug=os.getenv("FLASK_DEBUG") == "1",
    )

#!/usr/bin/env bash
# Lightpath: one command to install, build and open the full site.
#   ./run.sh            install Python deps, build the website (if Node is installed), start on :8000
#   SKIP_BUILD=1 ./run.sh   use the prebuilt site in web/dist
set -e
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
if [ ! -d .venv ]; then echo "Creating Python environment (.venv)"; $PY -m venv .venv; fi
# shellcheck disable=SC1091
. .venv/bin/activate
pip install -q --upgrade pip >/dev/null
pip install -q -r requirements.txt
if [ "${SKIP_BUILD:-0}" != "1" ] && command -v npm >/dev/null 2>&1; then
  echo "Building the website"
  (cd web && npm install --no-audit --no-fund --silent && npm run build --silent)
else
  echo "Using the prebuilt website in web/dist"
fi
PORT=${PORT:-8000}
echo ""
echo "  Lightpath is running at http://localhost:$PORT   (Ctrl+C to stop)"
echo ""
( sleep 2; if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT"; fi ) >/dev/null 2>&1 &
exec python -m uvicorn api.server:app --port "$PORT"

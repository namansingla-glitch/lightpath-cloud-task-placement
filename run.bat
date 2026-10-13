@echo off
REM Lightpath on Windows: install, build (if Node is installed) and start on http://localhost:8000
cd /d %~dp0
if not exist .venv ( python -m venv .venv )
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
where npm >nul 2>nul && ( cd web && call npm install --no-audit --no-fund && call npm run build && cd .. )
start "" http://localhost:8000
python -m uvicorn api.server:app --port 8000

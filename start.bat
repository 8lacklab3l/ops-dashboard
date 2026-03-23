@echo off
:: Ops Dashboard — Windows launcher
:: Requires Node.js 22.5+ (for node:sqlite built-in)

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: node.exe not found. Install Node.js 22.5+ and add it to PATH.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    npm install
    if errorlevel 1 (
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)

echo Starting Ops Dashboard on http://localhost:3000
node server.js

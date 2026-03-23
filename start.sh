#!/bin/sh
# Ops Dashboard — Linux/macOS launcher
# Requires Node.js 22.5+ (for node:sqlite built-in)

if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not found. Install Node.js 22.5+ and add it to PATH."
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm install || { echo "ERROR: npm install failed."; exit 1; }
fi

echo "Starting Ops Dashboard on http://localhost:3000"
node server.js

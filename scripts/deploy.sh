#!/bin/bash
set -euo pipefail

SOURCE="/home/user/projects/ework"
DEPLOY="/home/user/.local/share/ework"
SERVICE="ework.service"
BUN="/home/user/.local/lib/node-v25.9.0-linux-x64/lib/node_modules/bun/bin/bun.exe"

echo "🔍 Type checking..."
cd "$SOURCE" && "$BUN" run check 2>&1 | tail -1

echo "📦 Deploying to $DEPLOY..."
mkdir -p "$DEPLOY"
rsync -a --delete \
    --exclude '.git' \
    --exclude 'test/' \
    --exclude 'docs/' \
    --exclude 'node_modules/.cache' \
    "$SOURCE/src/" "$DEPLOY/src/"
cp "$SOURCE/package.json" "$SOURCE/tsconfig.json" "$DEPLOY/"
if [ -f "$SOURCE/.env" ]; then
    cp "$SOURCE/.env" "$DEPLOY/.env"
fi

echo "🔧 Installing dependencies..."
cd "$DEPLOY" && "$BUN" install 2>&1 | tail -1

if ! systemctl list-unit-files | grep -q "^$SERVICE"; then
    echo "📝 Installing $SERVICE..."
    sudo tee /etc/systemd/system/$SERVICE >/dev/null <<UNIT
[Unit]
Description=ework — standalone multi-project issue tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dog
Group=dog
WorkingDirectory=$DEPLOY
ExecStart=$BUN run src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=$DEPLOY/.env
Environment="PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/lib/node-v25.9.0-linux-x64/lib/node_modules/bun/bin:/home/user/go/bin"
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ework

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE"
fi

echo "🔄 Restarting $SERVICE..."
sudo systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
    echo "✅ Deploy successful"
else
    echo "❌ ERROR: service not active. Check: sudo journalctl -u $SERVICE -n 30"
    exit 1
fi

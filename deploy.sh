#!/bin/bash
# Push the app to the storyviz VM and restart it.
set -e
cd "$(dirname "$0")"
SSH="ssh -i $HOME/.ssh/exe_dev_techfren -o IdentitiesOnly=yes -o BatchMode=yes"
rsync -az --delete --exclude node_modules --exclude package.json --exclude package-lock.json -e "$SSH" app/ exedev@storyviz.exe.xyz:storyviz/app/
$SSH exedev@storyviz.exe.xyz 'set -e
cp ~/storyviz/app/agents/illustrator.AGENTS.md ~/storyviz/agents/illustrator/AGENTS.md
cp ~/storyviz/app/agents/coach.AGENTS.md ~/storyviz/agents/coach/AGENTS.md
if [ ! -f /etc/systemd/system/storyviz.service ]; then
sudo tee /etc/systemd/system/storyviz.service >/dev/null <<UNIT
[Unit]
Description=Storyviz app
After=network-online.target openclaw-gateway.service
[Service]
User=exedev
WorkingDirectory=/home/exedev/storyviz/app
Environment=PORT=8000
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=1
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload; sudo systemctl enable storyviz >/dev/null 2>&1
fi
sudo systemctl restart storyviz; sleep 1; systemctl is-active storyviz
curl -s -o /dev/null -w "index %{http_code}\n" http://127.0.0.1:8000/
curl -s http://127.0.0.1:8000/api/packs | python3 -c "import json,sys; print([(p[\"id\"],len(p[\"rules\"])) for p in json.load(sys.stdin)])"
curl -s -o /dev/null -w "three %{http_code}\n" http://127.0.0.1:8000/vendor/three/build/three.module.js'

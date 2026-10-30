#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data logs

# stop previous
if [[ -f /tmp/beri-server.pid ]]; then kill "$(cat /tmp/beri-server.pid)" 2>/dev/null || true; fi
if [[ -f /tmp/beri-hostc.pid ]]; then kill "$(cat /tmp/beri-hostc.pid)" 2>/dev/null || true; fi
pkill -f 'node server/index.js' 2>/dev/null || true
pkill -f 'hostc@latest 3847' 2>/dev/null || true
pkill -f 'hostc 3847' 2>/dev/null || true
sleep 0.5

nohup node server/index.js > logs/server.log 2>&1 &
echo $! > /tmp/beri-server.pid
sleep 0.8
curl -sf http://127.0.0.1:3847/api/health >/dev/null

nohup npx --yes hostc@latest 3847 > logs/hostc.log 2>&1 &
echo $! > /tmp/beri-hostc.pid

URL=""
for i in $(seq 1 40); do
  URL=$(grep -oE 'https://[a-z0-9]+\.hostc\.app' logs/hostc.log | head -1 || true)
  if [[ -n "${URL}" ]]; then break; fi
  sleep 0.5
done

if [[ -z "${URL}" ]]; then
  echo "hostc URL not ready; see logs/hostc.log" >&2
  exit 1
fi
echo "$URL" | tee PUBLIC_URL.txt
echo "Server PID $(cat /tmp/beri-server.pid) · hostc PID $(cat /tmp/beri-hostc.pid)"

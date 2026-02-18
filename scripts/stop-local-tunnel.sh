#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${ROOT_DIR}/.local-tunnel.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "No tunnel PID file found."
  exit 0
fi

ENTRY="$(cat "${PID_FILE}" || true)"
if [[ -z "${ENTRY}" ]]; then
  echo "Tunnel pid file is empty."
  rm -f "${PID_FILE}"
  exit 0
fi

if [[ "${ENTRY}" == screen:* ]]; then
  SESSION="${ENTRY#screen:}"
  # Quit all matching sessions (screen matches by substring, so loop until gone).
  while screen -ls | grep -q "[[:space:]]*[0-9]\\+\\.${SESSION}[[:space:]]"; do
    screen -S "${SESSION}" -X quit >/dev/null 2>&1 || true
    sleep 0.2
  done
  echo "Stopped tunnel screen session ${SESSION}."
else
  PID="${ENTRY}"
  if kill -0 "${PID}" >/dev/null 2>&1; then
    kill "${PID}" >/dev/null 2>&1 || true
    echo "Stopped tunnel process ${PID}."
  else
    echo "Tunnel process is not running."
  fi
fi

rm -f "${PID_FILE}"

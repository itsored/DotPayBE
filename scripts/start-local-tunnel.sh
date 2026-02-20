#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
PID_FILE="${ROOT_DIR}/.local-tunnel.pid"
LOG_FILE="${ROOT_DIR}/.local-tunnel.log"
SESSION_NAME="dotpay_local_tunnel"
BACKEND_SESSION_NAME="${BACKEND_SESSION_NAME:-dotpay_backend}"
RESTART_BACKEND="${RESTART_BACKEND:-true}"
PROVIDER="${TUNNEL_PROVIDER:-cloudflared}"
CLOUDFLARED_BIN=""

if ! command -v ssh >/dev/null 2>&1; then
  if [[ "${PROVIDER}" == "localhostrun" || "${PROVIDER}" == "pinggy" ]]; then
    echo "ssh is required but not installed."
    exit 1
  fi
fi

if ! command -v screen >/dev/null 2>&1; then
  echo "screen is required but not installed."
  echo "On macOS it is usually available at /usr/bin/screen."
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Create it first (cp .env.example .env)."
  exit 1
fi

# Ensure tunnel binary exists.
if [[ "${PROVIDER}" == "cloudflared" ]]; then
  CLOUDFLARED_BIN="$(command -v cloudflared || true)"
  if [[ -z "${CLOUDFLARED_BIN}" ]]; then
    echo "cloudflared is required but not installed."
    echo "Install: brew install cloudflared"
    exit 1
  fi
elif [[ "${PROVIDER}" != "localhostrun" && "${PROVIDER}" != "pinggy" ]]; then
  echo "Unsupported TUNNEL_PROVIDER=${PROVIDER}. Use cloudflared, localhostrun, or pinggy."
  exit 1
fi

# Prefer explicit PORT env var; otherwise read from .env; fall back to 4000.
PORT="${PORT:-}"
if [[ -z "${PORT}" ]]; then
  PORT="$(awk -F= '/^PORT=/{print $2}' "${ENV_FILE}" | tail -n 1 | tr -d '\r' | xargs || true)"
fi
PORT="${PORT:-4000}"

if [[ -f "${PID_FILE}" ]]; then
  OLD="$(cat "${PID_FILE}" || true)"
  if [[ -n "${OLD}" ]]; then
    if [[ "${OLD}" == screen:* ]]; then
      OLD_SESSION="${OLD#screen:}"
      # Quit all matching sessions (screen matches by substring, so loop until gone).
      while screen -ls | grep -q "[[:space:]]*[0-9]\\+\\.${OLD_SESSION}[[:space:]]"; do
        screen -S "${OLD_SESSION}" -X quit >/dev/null 2>&1 || true
        sleep 0.2
      done
    elif kill -0 "${OLD}" >/dev/null 2>&1; then
      kill "${OLD}" >/dev/null 2>&1 || true
      sleep 1
    fi
  fi
  rm -f "${PID_FILE}"
fi

# Best-effort cleanup in case the PID file was deleted but the screen session is still running.
while screen -ls | grep -q "[[:space:]]*[0-9]\\+\\.${SESSION_NAME}[[:space:]]"; do
  screen -S "${SESSION_NAME}" -X quit >/dev/null 2>&1 || true
  sleep 0.2
done

: > "${LOG_FILE}"

if [[ "${PROVIDER}" == "cloudflared" ]]; then
  # Quick tunnel, no account required (random trycloudflare.com hostname).
  # Default to HTTP/2 to avoid QUIC/UDP issues on restricted networks.
  CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
  CLOUDFLARED_HA_CONNECTIONS="${CLOUDFLARED_HA_CONNECTIONS:-2}"
  screen -dmS "${SESSION_NAME}" bash -lc \
    "exec \"${CLOUDFLARED_BIN}\" tunnel --url \"http://localhost:${PORT}\" --protocol \"${CLOUDFLARED_PROTOCOL}\" --ha-connections \"${CLOUDFLARED_HA_CONNECTIONS}\" --no-autoupdate --loglevel info >\"${LOG_FILE}\" 2>&1"
elif [[ "${PROVIDER}" == "localhostrun" ]]; then
  # SSH reverse tunnel. Note: anonymous localhost.run sessions may rotate hostnames.
  screen -dmS "${SESSION_NAME}" bash -lc \
    "exec ssh -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -R \"80:localhost:${PORT}\" nokey@localhost.run >\"${LOG_FILE}\" 2>&1"
else
  # SSH reverse tunnel via Pinggy. No auth token required for free temporary tunnels.
  screen -dmS "${SESSION_NAME}" bash -lc \
    "exec ssh -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -p 443 -R \"0:localhost:${PORT}\" a.pinggy.io >\"${LOG_FILE}\" 2>&1"
fi
echo "screen:${SESSION_NAME}" > "${PID_FILE}"

URL=""
SESSION_SEEN="false"
# Wait up to ~150s for the provider to print the public URL.
for _ in $(seq 1 300); do
  if screen -ls | grep -q "[[:space:]]*[0-9]\\+\\.${SESSION_NAME}[[:space:]]"; then
    SESSION_SEEN="true"
  elif [[ "${SESSION_SEEN}" == "true" ]]; then
    echo "Tunnel session exited unexpectedly."
    LC_ALL=C tr -d '\000' < "${LOG_FILE}" | tail -n 30 || true
    exit 1
  fi

  if [[ "${PROVIDER}" == "cloudflared" ]]; then
    # Example line contains: https://<id>.trycloudflare.com
    URL="$(
      LC_ALL=C tr -d '\000' < "${LOG_FILE}" 2>/dev/null \
        | grep -Eo 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' \
        | tail -n 1 \
        | tr -d '\r' \
        || true
    )"
  elif [[ "${PROVIDER}" == "localhostrun" ]]; then
    # Pick the last public URL announced by localhost.run.
    URL="$(
      LC_ALL=C tr -d '\000' < "${LOG_FILE}" 2>/dev/null \
        | awk '/tunneled with tls termination/ {print $NF}' \
        | tail -n 1 \
        | tr -d '\r' \
        || true
    )"
  else
    # Pick HTTPS URL announced by Pinggy.
    URL="$(
      LC_ALL=C tr -d '\000' < "${LOG_FILE}" 2>/dev/null \
        | grep -Eo 'https://[A-Za-z0-9.-]+\.pinggy\.link' \
        | tail -n 1 \
        | tr -d '\r' \
        || true
    )"
  fi
  if [[ -n "${URL}" ]]; then
    break
  fi
  sleep 0.5
done

if [[ -z "${URL}" ]]; then
  echo "Timed out waiting for tunnel URL."
  LC_ALL=C tr -d '\000' < "${LOG_FILE}" | tail -n 40 || true
  exit 1
fi

# Ensure it is reachable before writing it to .env.
REACHABLE="false"
for _ in $(seq 1 30); do
  if curl -fsS "${URL}/health" >/dev/null 2>&1; then
    REACHABLE="true"
    break
  fi
  sleep 0.5
done
if [[ "${REACHABLE}" != "true" ]]; then
  echo "Tunnel URL did not become reachable (health check failed): ${URL}"
  LC_ALL=C tr -d '\000' < "${LOG_FILE}" | tail -n 40 || true
  exit 1
fi

LC_ALL=C perl -0777 -i -pe "s|^MPESA_RESULT_BASE_URL=.*$|MPESA_RESULT_BASE_URL=${URL}|m; s|^MPESA_TIMEOUT_BASE_URL=.*$|MPESA_TIMEOUT_BASE_URL=${URL}|m" "${ENV_FILE}"

if ! grep -q '^MPESA_RESULT_BASE_URL=' "${ENV_FILE}"; then
  echo "MPESA_RESULT_BASE_URL=${URL}" >> "${ENV_FILE}"
fi
if ! grep -q '^MPESA_TIMEOUT_BASE_URL=' "${ENV_FILE}"; then
  echo "MPESA_TIMEOUT_BASE_URL=${URL}" >> "${ENV_FILE}"
fi

echo "Tunnel started: ${URL}"
echo "Tunnel screen session: ${SESSION_NAME}"
echo "Tunnel provider: ${PROVIDER}"
echo "Updated callback env keys in ${ENV_FILE}:"
grep -nE '^MPESA_RESULT_BASE_URL=|^MPESA_TIMEOUT_BASE_URL=' "${ENV_FILE}" || true
echo

if [[ "${RESTART_BACKEND}" == "true" ]]; then
  if screen -ls | grep -q "[[:space:]]*[0-9]\\+\\.${BACKEND_SESSION_NAME}[[:space:]]"; then
    screen -S "${BACKEND_SESSION_NAME}" -X quit >/dev/null 2>&1 || true
    sleep 0.2
  fi

  screen -dmS "${BACKEND_SESSION_NAME}" bash -lc "cd \"${ROOT_DIR}\" && npm start"
  echo "Restarted backend screen session: ${BACKEND_SESSION_NAME}"
else
  echo "Next:"
  echo "- Ensure backend is running on http://localhost:${PORT}"
  echo "- Restart backend so it picks up the new callback URL"
fi

# Shared helpers for the dev scripts that run a Limn server in the background.
# Source it after `srv` (the server pid) and `port` are set:
#   . "$(dirname "$0")/lib.sh"; trap kill_srv EXIT; wait_healthy

# The server stops on the first signal (close() calls the live-watch timer down), so
# the SIGKILL here is only a safety net for a wedged run — e.g. a headless Chrome
# holding a socket open — not a workaround for a known hang.
kill_srv() {
  kill "$srv" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$srv" 2>/dev/null || return 0; sleep 0.1; done
  kill -9 "$srv" 2>/dev/null || true
}

# Poll /health on 127.0.0.1:$port for ~10 s; fail the script loudly if it never answers.
wait_healthy() {
  for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && return 0; sleep 0.2; done
  echo "server never became healthy" >&2
  exit 1
}

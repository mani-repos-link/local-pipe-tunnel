#!/bin/sh

set -eu

APP_CONTAINER="${APP_CONTAINER:-local-pipe}"
TRAEFIK_CONTAINER="${TRAEFIK_CONTAINER:-traefik}"
DOCTOR_MODE="${DOCTOR_MODE:-auto}"
TIMEOUT="${TIMEOUT:-5}"
PUBLIC_SCHEME="${PUBLIC_SCHEME:-https}"
CHECK_PUBLIC="${CHECK_PUBLIC:-1}"

FAILURES=0
WARNINGS=0
TAB="$(printf '\t')"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  COLOR_OK="$(printf '\033[32m')"
  COLOR_WARN="$(printf '\033[33m')"
  COLOR_FAIL="$(printf '\033[31m')"
  COLOR_INFO="$(printf '\033[36m')"
  COLOR_RESET="$(printf '\033[0m')"
else
  COLOR_OK=""
  COLOR_WARN=""
  COLOR_FAIL=""
  COLOR_INFO=""
  COLOR_RESET=""
fi

section() {
  printf '\n%s== %s ==%s\n' "$COLOR_INFO" "$1" "$COLOR_RESET"
}

info() {
  printf '%s[i]%s %s\n' "$COLOR_INFO" "$COLOR_RESET" "$1"
}

ok() {
  printf '%s[ok]%s %s\n' "$COLOR_OK" "$COLOR_RESET" "$1"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  printf '%s[warn]%s %s\n' "$COLOR_WARN" "$COLOR_RESET" "$1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  printf '%s[fail]%s %s\n' "$COLOR_FAIL" "$COLOR_RESET" "$1"
}

cmd_exists() {
  command -v "$1" >/dev/null 2>&1
}

docker_available() {
  cmd_exists docker && docker ps >/dev/null 2>&1
}

docker_container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

docker_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || printf 'false')" = "true" ]
}

docker_health() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || printf 'unknown'
}

docker_network_mode() {
  docker inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null || printf ''
}

docker_env_value() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | awk -F= -v key="$2" '$1 == key { print substr($0, length($1) + 2); found = 1; exit } END { if (!found) exit 1 }'
}

docker_label_value() {
  value="$(docker inspect -f "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null || true)"
  if [ "$value" = "<no value>" ]; then
    value=""
  fi
  printf '%s' "$value"
}

http_code() {
  url="$1"

  if cmd_exists curl; then
    curl -ksS -o /dev/null --max-time "$TIMEOUT" -w '%{http_code}' "$url" 2>/dev/null || return 1
    return 0
  fi

  if cmd_exists wget; then
    if wget -q -T "$TIMEOUT" -O /dev/null "$url" >/dev/null 2>&1; then
      printf '200'
      return 0
    fi
    return 1
  fi

  return 127
}

listener_exists() {
  port="$1"

  if cmd_exists ss; then
    ss -ltn 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix"$" { found = 1 } END { exit found ? 0 : 1 }'
    return $?
  fi

  if cmd_exists netstat; then
    netstat -ltn 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix"$" { found = 1 } END { exit found ? 0 : 1 }'
    return $?
  fi

  return 2
}

extract_url_host() {
  printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://([^/:]+).*$#\1#'
}

extract_url_port() {
  url="$1"
  explicit="$(printf '%s' "$url" | sed -nE 's#^[a-zA-Z]+://[^/:]+:([0-9]+).*$#\1#p')"
  if [ -n "$explicit" ]; then
    printf '%s' "$explicit"
    return 0
  fi

  case "$url" in
    https://*) printf '443' ;;
    *) printf '80' ;;
  esac
}

probe_tcp_from_app() {
  host="$1"
  port="$2"

  docker exec "$APP_CONTAINER" node --input-type=module -e '
    import net from "node:net";
    const host = process.argv[1];
    const port = Number(process.argv[2]);
    const timeoutMs = Number(process.argv[3]);
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      process.stdout.write("ok\n");
      socket.destroy();
    });
    socket.on("timeout", () => {
      process.stderr.write("timeout\n");
      socket.destroy();
      process.exit(2);
    });
    socket.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  ' "$host" "$port" "$((TIMEOUT * 1000))"
}

load_routes_from_app() {
  config_path="$1"

  docker exec "$APP_CONTAINER" node --input-type=module -e '
    import fs from "node:fs";

    const configPath = process.argv[1];
    const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const parsed = raw.trim() ? JSON.parse(raw) : { routes: [] };

    for (const route of parsed.routes ?? []) {
      const target = new URL(route.target);
      const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
      const fields = [
        route.enabled === false ? "disabled" : "enabled",
        route.host ?? "",
        target.hostname ?? "",
        targetPort,
        route.target ?? "",
        route.localHost ?? "",
        route.localPort ?? "",
        route.sshTarget ?? "",
      ];
      process.stdout.write(fields.join("\t") + "\n");
    }
  ' "$config_path"
}

show_summary() {
  section "Summary"
  info "failures: $FAILURES"
  info "warnings: $WARNINGS"
}

run_container_mode() {
  app_port="${PORT:-8030}"
  config_path="${CONFIG_PATH:-/app/data/routes.json}"

  section "Mode"
  info "running reduced checks inside the container"
  info "port: $app_port"
  info "config path: $config_path"

  section "App"
  if http_code "http://127.0.0.1:$app_port/healthz" >/dev/null 2>&1; then
    ok "local-pipe answers on http://127.0.0.1:$app_port/healthz"
  else
    fail "local-pipe does not answer on http://127.0.0.1:$app_port/healthz"
  fi

  if [ -f "$config_path" ]; then
    ok "config file exists at $config_path"
  else
    fail "config file is missing at $config_path"
  fi

  section "Routes"
  if cmd_exists node && [ -f "$config_path" ]; then
    node --input-type=module -e '
      import fs from "node:fs";
      const configPath = process.argv[1];
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : { routes: [] };
      console.log(`routes: ${(parsed.routes ?? []).length}`);
      for (const route of parsed.routes ?? []) {
        console.log(`- ${route.enabled === false ? "disabled" : "enabled"} ${route.host} -> ${route.target}`);
      }
    ' "$config_path"
  else
    warn "node or config file unavailable; skipping route summary"
  fi

  show_summary

  if [ "$FAILURES" -gt 0 ]; then
    exit 1
  fi
}

run_host_mode() {
  section "Mode"
  info "running full host diagnostics with Docker"

  if ! docker_container_exists "$APP_CONTAINER"; then
    fail "container $APP_CONTAINER does not exist"
    show_summary
    exit 1
  fi

  if ! docker_container_exists "$TRAEFIK_CONTAINER"; then
    fail "container $TRAEFIK_CONTAINER does not exist"
    show_summary
    exit 1
  fi

  app_network_mode="$(docker_network_mode "$APP_CONTAINER")"
  traefik_network_mode="$(docker_network_mode "$TRAEFIK_CONTAINER")"
  app_health="$(docker_health "$APP_CONTAINER")"
  traefik_health="$(docker_health "$TRAEFIK_CONTAINER")"
  app_running="false"
  traefik_running="false"
  app_port="$(docker_env_value "$APP_CONTAINER" PORT 2>/dev/null || printf '8030')"
  admin_host="$(docker_env_value "$APP_CONTAINER" ADMIN_HOST 2>/dev/null || printf '')"
  config_path="$(docker_env_value "$APP_CONTAINER" CONFIG_PATH 2>/dev/null || printf '/app/data/routes.json')"
  default_remote_bind_host="$(docker_env_value "$APP_CONTAINER" DEFAULT_REMOTE_BIND_HOST 2>/dev/null || printf '127.0.0.1')"
  default_ssh_target="$(docker_env_value "$APP_CONTAINER" DEFAULT_SSH_TARGET 2>/dev/null || printf '')"
  backend_url="$(docker_label_value "$APP_CONTAINER" 'traefik.http.services.local-pipe.loadbalancer.server.url')"

  if docker_running "$APP_CONTAINER"; then
    app_running="true"
  fi

  if docker_running "$TRAEFIK_CONTAINER"; then
    traefik_running="true"
  fi

  section "Containers"
  if [ "$app_running" = "true" ]; then
    ok "$APP_CONTAINER is running (health: $app_health, network: $app_network_mode)"
  else
    fail "$APP_CONTAINER is not running"
  fi

  if [ "$traefik_running" = "true" ]; then
    ok "$TRAEFIK_CONTAINER is running (health: $traefik_health, network: $traefik_network_mode)"
  else
    fail "$TRAEFIK_CONTAINER is not running"
  fi

  section "App"
  if http_code "http://127.0.0.1:$app_port/healthz" >/dev/null 2>&1; then
    ok "host can reach local-pipe on http://127.0.0.1:$app_port/healthz"
  else
    fail "host cannot reach local-pipe on http://127.0.0.1:$app_port/healthz"
  fi

  if [ "$app_running" = "true" ]; then
    if docker exec "$APP_CONTAINER" wget -T "$TIMEOUT" -qO- "http://127.0.0.1:$app_port/healthz" >/dev/null 2>&1; then
      ok "$APP_CONTAINER can reach its own /healthz endpoint"
    else
      fail "$APP_CONTAINER cannot reach its own /healthz endpoint"
    fi
  fi

  if [ -n "$backend_url" ]; then
    backend_host="$(extract_url_host "$backend_url")"
    backend_port="$(extract_url_port "$backend_url")"
    info "traefik backend url: $backend_url"

    if [ "$traefik_network_mode" != "host" ] && { [ "$backend_host" = "127.0.0.1" ] || [ "$backend_host" = "localhost" ]; }; then
      fail "Traefik backend points to $backend_host while Traefik is not using host networking"
    fi
  else
    fail "Traefik backend label traefik.http.services.local-pipe.loadbalancer.server.url is missing"
    backend_host=""
    backend_port=""
  fi

  section "Traefik"
  gateway_line="$(docker inspect -f '{{range $name, $value := .NetworkSettings.Networks}}{{printf "%s\t%s\t%s\n" $name $value.Gateway $value.NetworkID}}{{end}}' "$TRAEFIK_CONTAINER" 2>/dev/null | awk 'NR == 1 { print $0 }')"
  if [ -n "$gateway_line" ]; then
    traefik_network_name="$(printf '%s' "$gateway_line" | cut -f1)"
    traefik_gateway="$(printf '%s' "$gateway_line" | cut -f2)"
    traefik_network_id="$(printf '%s' "$gateway_line" | cut -f3)"
    bridge_if="br-$(printf '%s' "$traefik_network_id" | cut -c1-12)"
    info "traefik network: $traefik_network_name"
    info "traefik gateway: $traefik_gateway"
    info "bridge interface: $bridge_if"
  else
    traefik_gateway=""
    bridge_if=""
    warn "could not determine Traefik network gateway"
  fi

  if [ -n "$backend_url" ] && [ "$traefik_running" = "true" ]; then
    backend_probe_output="$(docker exec "$TRAEFIK_CONTAINER" wget -T "$TIMEOUT" -S -O- "${backend_url%/}/healthz" >/dev/null 2>&1 && printf 'ok' || true)"
    if [ "$backend_probe_output" = "ok" ]; then
      ok "$TRAEFIK_CONTAINER can reach ${backend_url%/}/healthz"
    else
      fail "$TRAEFIK_CONTAINER cannot reach ${backend_url%/}/healthz"
      if [ -n "$bridge_if" ]; then
        info "firewall hint: allow tcp/$backend_port on interface $bridge_if if traffic is being dropped"
      fi
    fi
  fi

  if [ -f "./data/routes.json" ]; then
    ok "host routes file exists at ./data/routes.json"
  else
    warn "host routes file ./data/routes.json is missing"
  fi

  section "Routes"
  route_tmp="$(mktemp "${TMPDIR:-/tmp}/local-pipe-routes.XXXXXX")"
  trap 'rm -f "$route_tmp"' EXIT INT TERM

  if [ "$app_running" = "true" ] && load_routes_from_app "$config_path" >"$route_tmp" 2>/dev/null; then
    route_count="$(wc -l <"$route_tmp" | tr -d ' ')"
    info "loaded $route_count route(s) from $config_path"

    if [ "$route_count" = "0" ]; then
      warn "no routes are configured"
    fi

    while IFS="$TAB" read -r enabled route_host target_host target_port target local_host local_port ssh_target; do
      [ -n "$route_host" ] || continue
      info "$enabled route: $route_host -> $target"

      if [ "$enabled" = "enabled" ] && [ "$app_running" = "true" ]; then
        tcp_probe_output="$(probe_tcp_from_app "$target_host" "$target_port" 2>&1 || true)"

        if [ "$tcp_probe_output" = "ok" ]; then
          ok "$APP_CONTAINER can reach $target_host:$target_port for $route_host"
        else
          warn "$APP_CONTAINER cannot reach $target_host:$target_port for $route_host${tcp_probe_output:+ ($tcp_probe_output)}"
        fi

        if [ "$app_network_mode" != "host" ] && { [ "$target_host" = "127.0.0.1" ] || [ "$target_host" = "localhost" ]; }; then
          warn "$route_host targets loopback but $APP_CONTAINER is not using host networking"
        fi

        if { [ "$target_host" = "127.0.0.1" ] || [ "$target_host" = "localhost" ]; } && listener_exists "$target_port" 2>/dev/null; then
          ok "host listener exists on $target_host:$target_port"
        elif { [ "$target_host" = "127.0.0.1" ] || [ "$target_host" = "localhost" ]; }; then
          warn "no host listener on $target_host:$target_port for enabled route $route_host"
          suggested_ssh="${ssh_target:-$default_ssh_target}"
          suggested_local_host="${local_host:-127.0.0.1}"
          if [ -n "$suggested_ssh" ] && [ -n "$local_port" ]; then
            info "suggested SSH: ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R ${default_remote_bind_host}:${target_port}:${suggested_local_host}:${local_port} ${suggested_ssh}"
          fi
        fi

        if [ "$CHECK_PUBLIC" = "1" ] && [ -n "$route_host" ]; then
          public_code="$(http_code "${PUBLIC_SCHEME}://${route_host}/" 2>/dev/null || printf '000')"
          case "$public_code" in
            2??|3??)
              ok "public ${PUBLIC_SCHEME}://${route_host}/ -> HTTP $public_code"
              ;;
            401)
              if [ "$route_host" = "$admin_host" ]; then
                ok "public ${PUBLIC_SCHEME}://${route_host}/ -> HTTP 401 (expected auth challenge)"
              else
                warn "public ${PUBLIC_SCHEME}://${route_host}/ -> HTTP 401"
              fi
              ;;
            502|504)
              warn "public ${PUBLIC_SCHEME}://${route_host}/ -> HTTP $public_code (backend or tunnel issue)"
              ;;
            404)
              warn "public ${PUBLIC_SCHEME}://${route_host}/ -> HTTP 404 (missing Traefik router or route)"
              ;;
            000)
              warn "public ${PUBLIC_SCHEME}://${route_host}/ could not be reached"
              ;;
            *)
              warn "public ${PUBLIC_SCHEME}://${route_host}/ -> HTTP $public_code"
              ;;
          esac
        fi
      fi
    done <"$route_tmp"
  else
    fail "could not load routes from $config_path inside $APP_CONTAINER"
  fi

  if [ "$CHECK_PUBLIC" = "1" ] && [ -n "$admin_host" ]; then
    section "Public Dashboard"
    dashboard_code="$(http_code "${PUBLIC_SCHEME}://${admin_host}/" 2>/dev/null || printf '000')"
    case "$dashboard_code" in
      2??|3??)
        ok "public ${PUBLIC_SCHEME}://${admin_host}/ -> HTTP $dashboard_code"
        ;;
      401)
        ok "public ${PUBLIC_SCHEME}://${admin_host}/ -> HTTP 401 (expected auth challenge)"
        ;;
      000)
        fail "public ${PUBLIC_SCHEME}://${admin_host}/ could not be reached"
        ;;
      *)
        fail "public ${PUBLIC_SCHEME}://${admin_host}/ -> HTTP $dashboard_code"
        ;;
    esac
  fi

  show_summary

  if [ "$FAILURES" -gt 0 ]; then
    exit 1
  fi
}

MODE="$DOCTOR_MODE"

if [ "$MODE" = "auto" ]; then
  if docker_available; then
    MODE="host"
  else
    MODE="container"
  fi
fi

section "local-pipe doctor"
info "mode: $MODE"
info "timeout: ${TIMEOUT}s"

case "$MODE" in
  host)
    run_host_mode
    ;;
  container)
    run_container_mode
    ;;
  *)
    fail "unknown DOCTOR_MODE: $MODE"
    show_summary
    exit 1
    ;;
esac

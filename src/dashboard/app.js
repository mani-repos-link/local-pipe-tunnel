const state = {
  adminHost: "",
  authEnabled: false,
  configPath: "",
  routes: [],
  sshDefaults: {
    sshTarget: "",
    remoteBindHost: "",
    localHost: "127.0.0.1",
  },
};

const refs = {
  enabled: document.getElementById("enabled-count"),
  disabled: document.getElementById("disabled-count"),
  total: document.getElementById("total-count"),
  body: document.getElementById("routes-body"),
  form: document.getElementById("route-form"),
  resetButton: document.getElementById("reset-button"),
  reloadButton: document.getElementById("reload-button"),
  message: document.getElementById("message"),
  id: document.getElementById("route-id"),
  host: document.getElementById("route-host"),
  target: document.getElementById("route-target"),
  notes: document.getElementById("route-notes"),
  sshTarget: document.getElementById("route-ssh-target"),
  localPort: document.getElementById("route-local-port"),
  localHost: document.getElementById("route-local-host"),
  sshPreview: document.getElementById("ssh-preview"),
  enabledInput: document.getElementById("route-enabled"),
  submitButton: document.getElementById("submit-button"),
  metaAdminHost: document.getElementById("meta-admin-host"),
  metaConfigPath: document.getElementById("meta-config-path"),
  metaAuthEnabled: document.getElementById("meta-auth-enabled"),
  metaSshTarget: document.getElementById("meta-ssh-target"),
  metaRemoteBindHost: document.getElementById("meta-remote-bind-host"),
  metaLocalHost: document.getElementById("meta-local-host"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setMessage(text, type = "ok") {
  refs.message.textContent = text;
  refs.message.className = `message show ${type}`;
}

function clearMessage() {
  refs.message.className = "message";
  refs.message.textContent = "";
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function targetPortFromRoute(route) {
  try {
    const url = new URL(route.target);
    return Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

function getTunnelConfig(route) {
  return {
    sshTarget: route.sshTarget || state.sshDefaults.sshTarget || "",
    remoteBindHost: state.sshDefaults.remoteBindHost || "",
    localHost: route.localHost || state.sshDefaults.localHost || "127.0.0.1",
    localPort: route.localPort ? Number(route.localPort) : null,
    remotePort: targetPortFromRoute(route),
  };
}

function routeHasCommand(route) {
  const tunnel = getTunnelConfig(route);
  return Boolean(
    tunnel.sshTarget &&
      tunnel.remoteBindHost &&
      tunnel.localHost &&
      tunnel.localPort &&
      tunnel.remotePort,
  );
}

function shellEscape(value) {
  const raw = String(value);
  const quote = "'";
  return /^[A-Za-z0-9_./:@=-]+$/.test(raw)
    ? raw
    : quote + raw.split(quote).join(quote + '"' + quote + '"' + quote) + quote;
}

function buildSshCommand(route) {
  const tunnel = getTunnelConfig(route);

  if (!routeHasCommand(route)) {
    return "";
  }

  return [
    "ssh -NT",
    "-o ServerAliveInterval=30",
    "-o ServerAliveCountMax=3",
    "-o ExitOnForwardFailure=yes",
    "-R " +
      shellEscape(
        `${tunnel.remoteBindHost}:${tunnel.remotePort}:${tunnel.localHost}:${tunnel.localPort}`,
      ),
    shellEscape(tunnel.sshTarget),
  ].join(" ");
}

async function copyText(value) {
  if (!value) {
    throw new Error("No command available for this route yet.");
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  window.prompt("Copy command:", value);
}

function renderMeta() {
  refs.metaAdminHost.textContent = state.adminHost || "(not available)";
  refs.metaConfigPath.textContent = state.configPath || "(not available)";
  refs.metaAuthEnabled.textContent = state.authEnabled ? "enabled" : "disabled";
  refs.metaSshTarget.textContent = state.sshDefaults.sshTarget || "(not set)";
  refs.metaRemoteBindHost.textContent =
    state.sshDefaults.remoteBindHost ||
    "(auto-detect unavailable, set DEFAULT_REMOTE_BIND_HOST)";
  refs.metaLocalHost.textContent =
    state.sshDefaults.localHost || "127.0.0.1";
}

function renderRoutes() {
  const enabledCount = state.routes.filter((route) => route.enabled).length;
  refs.enabled.textContent = String(enabledCount);
  refs.disabled.textContent = String(state.routes.length - enabledCount);
  refs.total.textContent = String(state.routes.length);

  if (!state.routes.length) {
    refs.body.innerHTML =
      '<tr><td colspan="5" class="route-meta">No routes yet. Add the host after you create DNS and Traefik labels for it.</td></tr>';
    return;
  }

  refs.body.innerHTML = state.routes
    .map((route) => {
      const notes = route.notes ? escapeHtml(route.notes) : "No notes";
      const host = escapeHtml(route.host);
      const target = escapeHtml(route.target);
      const tunnel = getTunnelConfig(route);
      const tunnelReady = routeHasCommand(route);
      const tunnelState = tunnelReady
        ? '<span class="chip">command ready</span>'
        : '<span class="chip warn">incomplete</span>';
      const sshTarget = tunnel.sshTarget
        ? `<div class="route-meta">SSH destination: <code>${escapeHtml(tunnel.sshTarget)}</code></div>`
        : '<div class="route-meta">SSH destination: not set</div>';
      const localTarget = tunnel.localPort
        ? `<div class="route-meta">Local target: <code>${escapeHtml(tunnel.localHost)}:${escapeHtml(String(tunnel.localPort))}</code></div>`
        : '<div class="route-meta">Local target: local port not set</div>';
      const remoteBind =
        tunnel.remotePort && tunnel.remoteBindHost
          ? `<div class="route-meta">Remote bind: <code>${escapeHtml(tunnel.remoteBindHost)}:${escapeHtml(String(tunnel.remotePort))}</code></div>`
          : '<div class="route-meta">Remote bind: remote bind host or target port unavailable</div>';

      return `
        <tr>
          <td>
            <div class="route-host"><a href="https://${host}" target="_blank" rel="noreferrer">${host}</a></div>
            <div class="route-meta">Updated ${formatDate(route.updatedAt)}</div>
            <div class="route-meta">${notes}</div>
          </td>
          <td>
            <code>${target}</code>
          </td>
          <td>
            ${tunnelState}
            ${sshTarget}
            ${localTarget}
            ${remoteBind}
          </td>
          <td>
            <span class="chip ${route.enabled ? "" : "off"}">${route.enabled ? "enabled" : "disabled"}</span>
          </td>
          <td>
            <div class="actions">
              <button class="secondary" type="button" data-action="copy-ssh" data-id="${route.id}" ${tunnelReady ? "" : "disabled"}>Copy SSH</button>
              <button class="secondary" type="button" data-action="edit" data-id="${route.id}">Edit</button>
              <button class="secondary" type="button" data-action="toggle" data-id="${route.id}">${route.enabled ? "Disable" : "Enable"}</button>
              <button class="danger" type="button" data-action="delete" data-id="${route.id}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function resetForm() {
  refs.form.reset();
  refs.id.value = "";
  refs.enabledInput.checked = true;
  refs.sshTarget.value = state.sshDefaults.sshTarget || "";
  refs.localHost.value = state.sshDefaults.localHost || "127.0.0.1";
  refs.localPort.value = "";
  refs.submitButton.textContent = "Save route";
  updatePreview();
}

function draftRoute() {
  return {
    host: refs.host.value.trim(),
    target: refs.target.value.trim(),
    sshTarget: refs.sshTarget.value.trim(),
    localHost: refs.localHost.value.trim(),
    localPort: refs.localPort.value ? Number(refs.localPort.value) : null,
  };
}

function updatePreview() {
  const route = draftRoute();
  const sshCommand = buildSshCommand(route);

  if (!sshCommand) {
    refs.sshPreview.textContent =
      "Complete SSH destination, target, and local port to preview the command.";
    return;
  }

  refs.sshPreview.textContent = sshCommand;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const payload = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || "Request failed.");
  }

  return response.json().catch(() => ({}));
}

async function loadRoutes() {
  const payload = await request("/api/state");
  state.adminHost = payload.adminHost || "";
  state.authEnabled = Boolean(payload.authEnabled);
  state.configPath = payload.configPath || "";
  state.routes = payload.routes || [];
  state.sshDefaults = {
    ...state.sshDefaults,
    ...(payload.sshDefaults || {}),
  };
  renderMeta();
  renderRoutes();
}

refs.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();

  try {
    await request("/api/routes", {
      method: "POST",
      body: JSON.stringify({
        id: refs.id.value || undefined,
        host: refs.host.value,
        target: refs.target.value,
        notes: refs.notes.value,
        sshTarget: refs.sshTarget.value,
        localPort: refs.localPort.value
          ? Number(refs.localPort.value)
          : undefined,
        localHost: refs.localHost.value,
        enabled: refs.enabledInput.checked,
      }),
    });
    await loadRoutes();
    resetForm();
    setMessage("Route saved.");
  } catch (error) {
    setMessage(error.message, "error");
  }
});

refs.body.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  clearMessage();
  const action = button.dataset.action;
  const route = state.routes.find((entry) => entry.id === button.dataset.id);

  if (!route) {
    setMessage("Route not found.", "error");
    return;
  }

  if (action === "copy-ssh") {
    try {
      await copyText(buildSshCommand(route));
      setMessage("SSH command copied.");
    } catch (error) {
      setMessage(error.message, "error");
    }
    return;
  }

  if (action === "edit") {
    refs.id.value = route.id;
    refs.host.value = route.host;
    refs.target.value = route.target;
    refs.notes.value = route.notes;
    refs.sshTarget.value =
      route.sshTarget || state.sshDefaults.sshTarget || "";
    refs.localHost.value =
      route.localHost || state.sshDefaults.localHost || "127.0.0.1";
    refs.localPort.value = route.localPort || "";
    refs.enabledInput.checked = route.enabled;
    refs.submitButton.textContent = "Update route";
    refs.host.focus();
    updatePreview();
    return;
  }

  if (action === "delete" && !window.confirm(`Delete ${route.host}?`)) {
    return;
  }

  try {
    const endpoint =
      action === "toggle"
        ? `/api/routes/${route.id}/toggle`
        : `/api/routes/${route.id}`;
    const method = action === "toggle" ? "POST" : "DELETE";
    await request(endpoint, { method });
    await loadRoutes();
    setMessage(
      action === "toggle" ? "Route state updated." : "Route deleted.",
    );
  } catch (error) {
    setMessage(error.message, "error");
  }
});

refs.resetButton.addEventListener("click", () => {
  clearMessage();
  resetForm();
});

refs.reloadButton.addEventListener("click", async () => {
  clearMessage();
  try {
    await request("/api/reload", { method: "POST", body: "{}" });
    await loadRoutes();
    setMessage("Config reloaded from disk.");
  } catch (error) {
    setMessage(error.message, "error");
  }
});

for (const input of [
  refs.target,
  refs.sshTarget,
  refs.localPort,
  refs.localHost,
]) {
  input.addEventListener("input", updatePreview);
}

renderMeta();
resetForm();
loadRoutes().catch((error) => setMessage(error.message, "error"));

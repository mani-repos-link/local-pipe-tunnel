function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializeForScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function renderDashboard({
  adminHost,
  configPath,
  authEnabled,
  sshDefaults,
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Local Pipe</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3efe5;
        --card: rgba(255, 252, 245, 0.92);
        --ink: #182027;
        --muted: #58636e;
        --line: rgba(24, 32, 39, 0.12);
        --brand: #0a7a63;
        --brand-ink: #06372d;
        --danger: #a93628;
        --danger-soft: #f8ded9;
        --warning: #7d5b00;
        --chip: #e4efe9;
        --shadow: 0 24px 60px rgba(20, 31, 41, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        background:
          radial-gradient(circle at top left, rgba(10, 122, 99, 0.12), transparent 34%),
          radial-gradient(circle at top right, rgba(169, 54, 40, 0.08), transparent 30%),
          linear-gradient(180deg, #fbf8f2 0%, var(--bg) 100%);
        color: var(--ink);
      }

      .shell {
        width: min(1260px, calc(100vw - 32px));
        margin: 32px auto 48px;
      }

      .hero {
        display: grid;
        gap: 16px;
        margin-bottom: 24px;
      }

      .eyebrow {
        font-size: 13px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--brand);
        font-weight: 700;
      }

      h1 {
        margin: 0;
        font-size: clamp(2.2rem, 5vw, 4rem);
        line-height: 0.95;
        max-width: 10ch;
      }

      .hero-copy {
        max-width: 72ch;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
      }

      .hero-grid {
        display: grid;
        grid-template-columns: 1.35fr 1fr;
        gap: 16px;
      }

      .panel {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 22px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .meta,
      .toolbar,
      .table-wrap,
      .form-wrap {
        padding: 20px;
      }

      .meta-list {
        display: grid;
        gap: 10px;
        color: var(--muted);
      }

      .meta code,
      code {
        color: var(--brand-ink);
        background: rgba(10, 122, 99, 0.08);
        padding: 2px 6px;
        border-radius: 999px;
        word-break: break-word;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        padding: 20px;
      }

      .stat {
        padding: 16px;
        background: rgba(255, 255, 255, 0.5);
        border: 1px solid var(--line);
        border-radius: 18px;
      }

      .stat strong {
        display: block;
        font-size: 1.7rem;
        margin-bottom: 6px;
      }

      .stat span {
        color: var(--muted);
        font-size: 0.92rem;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
      }

      .toolbar p,
      .route-meta,
      .hint {
        margin: 0;
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.55;
      }

      .toolbar-actions,
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      button {
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
        transition: transform 0.14s ease, box-shadow 0.14s ease, opacity 0.14s ease;
      }

      button:hover:not(:disabled) {
        transform: translateY(-1px);
      }

      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .primary {
        color: white;
        background: linear-gradient(135deg, #0a7a63, #095646);
        box-shadow: 0 12px 20px rgba(10, 122, 99, 0.18);
      }

      .secondary {
        color: var(--brand-ink);
        background: rgba(10, 122, 99, 0.08);
      }

      .danger {
        color: var(--danger);
        background: var(--danger-soft);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th,
      td {
        text-align: left;
        padding: 14px 10px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-size: 0.88rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      tr:last-child td {
        border-bottom: 0;
      }

      .route-host {
        font-weight: 700;
        margin-bottom: 6px;
      }

      .route-host a {
        color: inherit;
        text-decoration: none;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--chip);
        color: var(--brand-ink);
        font-size: 0.85rem;
        font-weight: 700;
      }

      .chip.off {
        background: rgba(125, 91, 0, 0.12);
        color: var(--warning);
      }

      .chip.warn {
        background: rgba(169, 54, 40, 0.12);
        color: var(--danger);
      }

      form {
        display: grid;
        gap: 14px;
      }

      .form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }

      label {
        display: grid;
        gap: 8px;
        font-size: 0.9rem;
        color: var(--muted);
      }

      input,
      textarea {
        width: 100%;
        border-radius: 16px;
        border: 1px solid var(--line);
        padding: 12px 14px;
        font: inherit;
        color: var(--ink);
        background: rgba(255, 255, 255, 0.86);
      }

      textarea {
        min-height: 100px;
        resize: vertical;
      }

      .checkbox {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--ink);
      }

      .message {
        display: none;
        padding: 12px 14px;
        border-radius: 16px;
        font-size: 0.95rem;
        margin-bottom: 14px;
      }

      .message.show {
        display: block;
      }

      .message.ok {
        background: rgba(10, 122, 99, 0.08);
        color: var(--brand-ink);
      }

      .message.error {
        background: var(--danger-soft);
        color: var(--danger);
      }

      .code-preview {
        margin: 0;
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.65);
        color: var(--ink);
        font: 0.88rem/1.5 "SFMono-Regular", "Menlo", "Monaco", monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .section-title {
        margin: 4px 0 10px;
        color: var(--brand-ink);
        font-size: 0.98rem;
        font-weight: 700;
      }

      @media (max-width: 1024px) {
        .hero-grid,
        .form-grid,
        .stats {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 860px) {
        th:nth-child(3),
        td:nth-child(3) {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">Local Pipe</div>
        <div class="hero-grid">
          <div class="panel meta">
            <h1>Manual hosts, fast tunnel routing.</h1>
            <p class="hero-copy">
              This service sits behind Traefik, matches the request host, and proxies to the target saved in the JSON config.
              Keep the Traefik routers explicit with <code>Host()</code> labels, keep the route mapping here, and optionally store SSH metadata so the dashboard can generate the exact tunnel command.
            </p>
            <div class="meta-list">
              <div>Dashboard host: <code>${escapeHtml(adminHost)}</code></div>
              <div>Config file: <code>${escapeHtml(configPath)}</code></div>
              <div>Admin auth: <code>${authEnabled ? "enabled" : "disabled"}</code></div>
              <div>Default SSH destination: <code>${escapeHtml(sshDefaults?.sshTarget || "(not set)")}</code></div>
              <div>Default remote bind host: <code>${escapeHtml(sshDefaults?.remoteBindHost || "(auto-detect failed, set DEFAULT_REMOTE_BIND_HOST)")}</code></div>
              <div>Default local host: <code>${escapeHtml(sshDefaults?.localHost || "127.0.0.1")}</code></div>
            </div>
          </div>
          <div class="panel stats">
            <div class="stat">
              <strong id="enabled-count">0</strong>
              <span>Enabled routes</span>
            </div>
            <div class="stat">
              <strong id="disabled-count">0</strong>
              <span>Disabled routes</span>
            </div>
            <div class="stat">
              <strong id="total-count">0</strong>
              <span>Total routes</span>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="toolbar">
          <p>Each tunnel host still needs DNS and an explicit Traefik <code>Host()</code> router. The table below decides where that host proxies and, if you fill the SSH metadata, generates the tunnel command too.</p>
          <div class="toolbar-actions">
            <button class="secondary" type="button" id="reload-button">Reload JSON</button>
            <button class="secondary" type="button" id="reset-button">Clear form</button>
          </div>
        </div>
        <div class="table-wrap">
          <div class="message" id="message"></div>
          <table>
            <thead>
              <tr>
                <th>Host</th>
                <th>Target</th>
                <th>Tunnel</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="routes-body">
              <tr>
                <td colspan="5" class="route-meta">Loading routes...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <div class="form-wrap">
          <form id="route-form">
            <input type="hidden" name="id" id="route-id" />
            <div class="section-title">Route</div>
            <div class="form-grid">
              <label>
                Host
                <input name="host" id="route-host" placeholder="stripe.local-pipe.example.com" required />
              </label>
              <label>
                Target
                <input name="target" id="route-target" placeholder="http://host.docker.internal:41001" required />
              </label>
            </div>
            <label>
              Notes
              <textarea name="notes" id="route-notes" placeholder="Optional operator note"></textarea>
            </label>

            <div class="section-title">SSH Generator</div>
            <div class="form-grid">
              <label>
                SSH destination
                <input name="sshTarget" id="route-ssh-target" placeholder="tunnel@example-vps" />
              </label>
              <label>
                Local port
                <input name="localPort" id="route-local-port" type="number" min="1" max="65535" placeholder="3000" />
              </label>
              <label>
                Remote bind host
                <input name="remoteBindHost" id="route-remote-bind-host" placeholder="auto-detected from host.docker.internal" />
              </label>
              <label>
                Local host
                <input name="localHost" id="route-local-host" placeholder="127.0.0.1" />
              </label>
            </div>
            <div class="hint">
              If SSH destination and local port are set, the dashboard can generate the exact command for this route. Remote port is derived automatically from the target URL port.
            </div>
            <pre class="code-preview" id="ssh-preview">Complete the SSH fields to preview a command.</pre>

            <label class="checkbox">
              <input type="checkbox" name="enabled" id="route-enabled" checked />
              Enable route immediately
            </label>
            <div class="toolbar-actions">
              <button class="primary" type="submit" id="submit-button">Save route</button>
            </div>
          </form>
        </div>
      </section>
    </div>

    <script>
      const state = {
        routes: [],
        sshDefaults: ${serializeForScript(sshDefaults || {
          sshTarget: "",
          remoteBindHost: "",
          localHost: "127.0.0.1",
        })},
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
        remoteBindHost: document.getElementById("route-remote-bind-host"),
        localHost: document.getElementById("route-local-host"),
        sshPreview: document.getElementById("ssh-preview"),
        enabledInput: document.getElementById("route-enabled"),
        submitButton: document.getElementById("submit-button"),
      };

      function escapeClientHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function setMessage(text, type = "ok") {
        refs.message.textContent = text;
        refs.message.className = \`message show \${type}\`;
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
          remoteBindHost: route.remoteBindHost || state.sshDefaults.remoteBindHost || "",
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
        return /^[A-Za-z0-9_./:@=-]+$/.test(raw)
          ? raw
          : "'" + raw.replaceAll("'", "'\"'\"'") + "'";
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
          "-R " + shellEscape(\`\${tunnel.remoteBindHost}:\${tunnel.remotePort}:\${tunnel.localHost}:\${tunnel.localPort}\`),
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

      function render() {
        const enabledCount = state.routes.filter((route) => route.enabled).length;
        refs.enabled.textContent = String(enabledCount);
        refs.disabled.textContent = String(state.routes.length - enabledCount);
        refs.total.textContent = String(state.routes.length);

        if (!state.routes.length) {
          refs.body.innerHTML = '<tr><td colspan="5" class="route-meta">No routes yet. Add the host after you create DNS and Traefik labels for it.</td></tr>';
          return;
        }

        refs.body.innerHTML = state.routes.map((route) => {
          const notes = route.notes ? escapeClientHtml(route.notes) : "No notes";
          const host = escapeClientHtml(route.host);
          const target = escapeClientHtml(route.target);
          const tunnel = getTunnelConfig(route);
          const tunnelReady = routeHasCommand(route);
          const tunnelState = tunnelReady
            ? \`<span class="chip">command ready</span>\`
            : \`<span class="chip warn">incomplete</span>\`;
          const sshTarget = tunnel.sshTarget
            ? \`<div class="route-meta">SSH destination: <code>\${escapeClientHtml(tunnel.sshTarget)}</code></div>\`
            : '<div class="route-meta">SSH destination: not set</div>';
          const localTarget = tunnel.localPort
            ? \`<div class="route-meta">Local target: <code>\${escapeClientHtml(tunnel.localHost)}:\${escapeClientHtml(String(tunnel.localPort))}</code></div>\`
            : '<div class="route-meta">Local target: local port not set</div>';
          const remoteBind = tunnel.remotePort
            ? \`<div class="route-meta">Remote bind: <code>\${escapeClientHtml(tunnel.remoteBindHost)}:\${escapeClientHtml(String(tunnel.remotePort))}</code></div>\`
            : '<div class="route-meta">Remote bind: target port unavailable</div>';

          return \`
            <tr>
              <td>
                <div class="route-host"><a href="https://\${host}" target="_blank" rel="noreferrer">\${host}</a></div>
                <div class="route-meta">Updated \${formatDate(route.updatedAt)}</div>
                <div class="route-meta">\${notes}</div>
              </td>
              <td>
                <code>\${target}</code>
              </td>
              <td>
                \${tunnelState}
                \${sshTarget}
                \${localTarget}
                \${remoteBind}
              </td>
              <td>
                <span class="chip \${route.enabled ? "" : "off"}">\${route.enabled ? "enabled" : "disabled"}</span>
              </td>
              <td>
                <div class="actions">
                  <button class="secondary" type="button" data-action="copy-ssh" data-id="\${route.id}" \${tunnelReady ? "" : "disabled"}>Copy SSH</button>
                  <button class="secondary" type="button" data-action="edit" data-id="\${route.id}">Edit</button>
                  <button class="secondary" type="button" data-action="toggle" data-id="\${route.id}">\${route.enabled ? "Disable" : "Enable"}</button>
                  <button class="danger" type="button" data-action="delete" data-id="\${route.id}">Delete</button>
                </div>
              </td>
            </tr>
          \`;
        }).join("");
      }

      function resetForm() {
        refs.form.reset();
        refs.id.value = "";
        refs.enabledInput.checked = true;
        refs.sshTarget.value = state.sshDefaults.sshTarget || "";
        refs.remoteBindHost.value = state.sshDefaults.remoteBindHost || "";
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
          remoteBindHost: refs.remoteBindHost.value.trim(),
          localHost: refs.localHost.value.trim(),
          localPort: refs.localPort.value ? Number(refs.localPort.value) : null,
        };
      }

      function updatePreview() {
        const route = draftRoute();
        const sshCommand = buildSshCommand(route);

        if (!sshCommand) {
          refs.sshPreview.textContent = "Complete SSH destination, target, and local port to preview the command.";
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
          const payload = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error(payload.error || "Request failed.");
        }

        return response.json().catch(() => ({}));
      }

      async function loadRoutes() {
        const payload = await request("/api/state");
        state.routes = payload.routes || [];
        state.sshDefaults = payload.sshDefaults || state.sshDefaults;
        render();
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
              localPort: refs.localPort.value ? Number(refs.localPort.value) : undefined,
              remoteBindHost: refs.remoteBindHost.value,
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
          refs.sshTarget.value = route.sshTarget || state.sshDefaults.sshTarget || "";
          refs.remoteBindHost.value = route.remoteBindHost || state.sshDefaults.remoteBindHost || "";
          refs.localHost.value = route.localHost || state.sshDefaults.localHost || "127.0.0.1";
          refs.localPort.value = route.localPort || "";
          refs.enabledInput.checked = route.enabled;
          refs.submitButton.textContent = "Update route";
          refs.host.focus();
          updatePreview();
          return;
        }

        if (action === "delete" && !window.confirm(\`Delete \${route.host}?\`)) {
          return;
        }

        try {
          const endpoint = action === "toggle"
            ? \`/api/routes/\${route.id}/toggle\`
            : \`/api/routes/\${route.id}\`;
          const method = action === "toggle" ? "POST" : "DELETE";
          await request(endpoint, { method });
          await loadRoutes();
          setMessage(action === "toggle" ? "Route state updated." : "Route deleted.");
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
        refs.remoteBindHost,
        refs.localHost,
      ]) {
        input.addEventListener("input", updatePreview);
      }

      resetForm();
      loadRoutes().catch((error) => setMessage(error.message, "error"));
    </script>
  </body>
</html>`;
}

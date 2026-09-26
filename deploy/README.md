# Self-hosted feedback server

Run one Agentation server for your whole team. People leave feedback on your
sites with the browser extension; developers read and resolve it from Claude
Code, per project.

```
Browser extension ──HTTPS + ingest key──▶ feedback.your-domain.com (Cloudflare)
 (installed for everyone                         │  Cloudflare Tunnel (outbound only)
  by Google Workspace)                           ▼
                              docker compose: cloudflared ──▶ agentation server (SQLite volume)
                                                 ▲
Claude Code ──HTTPS /mcp + agent key, project + domains──┘
```

- **Domains allowlist**: a site can send feedback only after a developer's MCP
  config registers its domain (`--domains`). Admins remove or re-enable domains
  with MCP tools.
- **Two keys**: the *agent* key (Claude Code) can do everything; the *ingest* key
  (extension) can only submit feedback and read feedback of allowlisted domains.
- Nothing about your domains or keys lives in this repo: keys are in `.env` on
  the server and in the Workspace policy; domains are in each project's MCP config.

## 1. Server (VPS)

Requirements: Docker with Compose, and a domain on Cloudflare. HTTPS and the
domain come from a **Cloudflare Tunnel**: the server opens no ports and holds
no certificates — starting the containers is all it takes.

**Create the tunnel** (once, in the Cloudflare dashboard):

1. *Zero Trust → Networks → Tunnels → Create a tunnel* → type **Cloudflared**,
   name it (e.g. `agentation`).
2. On the install step, copy the **token** (the long value after
   `--token` in the command shown). You don't need to run that command.
3. *Public Hostname → Add*: subdomain `feedback`, your domain, service
   **HTTP** `agentation:4747` (the server's name inside Docker Compose).

**Start the server:**

```bash
git clone https://github.com/<you>/agentation.git && cd agentation/deploy
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml

# Put a strong password in each key (format user:password) and the tunnel token
openssl rand -base64 24   # run twice, one per key
nano .env

docker compose up -d --build
docker compose ps          # agentation: healthy, cloudflared: running
curl https://feedback.your-domain.com/health   # {"status":"ok",...}
```

`cloudflared` starts once the server is healthy and reconnects on its own.

Cloudflare notes:

- **Don't put Cloudflare Access (login) in front of this hostname.** The
  extension and Claude Code authenticate with their own keys and can't pass
  an Access login screen.
- Live updates (server-sent events) work through the tunnel: the server sends a
  keep-alive every 30s, under Cloudflare's 100s idle limit.

Updating: `git pull && docker compose up -d --build` (the server doesn't reload
code on its own). Data is in the `agentation-data` volume; back it up with
`docker run --rm -v deploy_agentation-data:/data -v "$PWD":/backup alpine tar czf /backup/agentation-data.tgz -C /data .`

### Without Cloudflare (Caddy or Nginx)

Point a DNS record at the server, remove the `cloudflared` service from
`docker-compose.yml`, and uncomment the `ports` of `agentation` so it listens on
`127.0.0.1:4747`. Then put a reverse proxy in front:

- **Caddy** (automatic certificates): copy `Caddyfile.example`, replace the
  domain, reload Caddy.
- **Nginx**: use `nginx.example.conf`. Keep `proxy_buffering off` and the long
  `proxy_read_timeout` — live updates use server-sent events, which break behind
  a buffering proxy.

## 2. Developers (Claude Code)

Claude Code connects straight to the server over HTTP — nothing to clone,
build or install.

**Once per project** (whoever sets it up): copy
[`mcp.example.json`](../mcp.example.json) to `.mcp.json` at the project root,
fill in the three values below, and **commit it** (it holds no secret):

- `url`: your server + `/mcp`
- `X-Agentation-Project`: a name for the project
- `X-Agentation-Domains`: every host where this project runs (production,
  staging, `localhost:3000`…), exactly as in the browser, with the port if any

**Each new developer**: add the agent key to your shell profile (e.g.
`~/.zshrc`), open a new terminal, and start `claude` in the project. Approve the
project's `agentation` MCP server when Claude Code asks.

```bash
export AGENTATION_AGENT_AUTH="agent:<password from the server's .env>"
```

Claude Code fills in `${AGENTATION_AGENT_AUTH}` from your environment **when it
starts** — restart `claude` after changing the key. On connect, the server
registers the project's domains on the allowlist, and the tools only return
feedback from them.

> Claude Code opened from the desktop app or an IDE on macOS may not read
> `~/.zshrc`. Set the variable for GUI apps with
> `launchctl setenv AGENTATION_AGENT_AUTH "agent:<password>"`, or use
> `claude mcp add` below.

### Check it works

In the project run `claude`, then `/mcp`: `agentation` should be **connected**.
Ask Claude Code to "list agentation domains" — you should see this project's
domains.

- `401 Unauthorized` → the key is wrong or wasn't loaded into Claude Code's
  environment.
- "Dynamic Client Registration rejected" → the server runs an older build
  that doesn't accept `X-Agentation-Auth` yet: rebuild and restart it.

### Only on your machine (`claude mcp add`)

To skip `.mcp.json`, or if the variable isn't picked up, add the server for
yourself (stored in `~/.claude.json`, not in the repo):

```bash
claude mcp add --transport http --scope local agentation https://feedback.your-domain.com/mcp \
  --header "X-Agentation-Auth: agent:<password>" \
  --header "X-Agentation-Project: your-project" \
  --header "X-Agentation-Domains: your-domain.com,staging.your-domain.com,localhost:3000"
```

### Running the MCP client locally (stdio)

Instead of HTTP you can run the MCP client on your machine: build this repo
(`pnpm install && pnpm --filter agentation-mcp build`) and use
[`mcp.stdio.example.json`](../mcp.stdio.example.json). It takes the same values as
flags (`--project`, `--domains`) and the key as `AGENTATION_AUTH`. The published
`agentation-mcp` on npm doesn't have these options yet.

### Tools

| Tool | What it does |
|---|---|
| `agentation_get_all_pending` / `agentation_watch_annotations` | Feedback to work on for this project |
| `agentation_acknowledge` / `agentation_resolve` / `agentation_dismiss` / `agentation_reply` | Update feedback (people see it live in the extension) |
| `agentation_list_domains` | All registered domains, their project and status |
| `agentation_remove_domain` | Stop accepting feedback from a domain (kept, not deleted; configs can't re-enable it) |
| `agentation_enable_domain` | Accept feedback from a removed domain again |

## 3. Google Workspace admin (browser extension)

1. Package the extension (from the repo root):
   `pnpm install && pnpm build && pnpm --filter agentation-extension zip` →
   `extension/agentation-extension.zip`.
2. Upload it to the Chrome Web Store developer dashboard with visibility
   **Private** (your Workspace domain only).
3. In the Admin console: *Devices → Chrome → Apps & extensions → Users &
   browsers*, add the extension by ID and set it to **Force install**.
4. In the same place, under *Policy for extensions*, paste:

```json
{
  "endpoint":    { "Value": "https://feedback.your-domain.com" },
  "ingestAuth":  { "Value": "extension:<password from .env>" },
  "brandName":   { "Value": "Your name" },
  "brandSlogan": { "Value": "Built by your team" }
}
```

People then see the extension without any setup. It's active only on
allowlisted sites; the toolbar button shows whether the current site is
supported.

## Security notes

- **Rotate keys** by changing `.env` and running `docker compose up -d`, then
  update the Workspace policy (ingest key) and developers' shells (agent key).
- The **ingest key is readable** by anyone who has the extension (it's in the
  policy). That's why it can't resolve, delete or manage domains, and only works
  for allowlisted domains.
- The **reporter email** attached to feedback comes from the extension and isn't
  verified by the server — fine for an internal tool, not proof of identity.
- Request bodies are capped at 2MB. Event history for replay is kept
  `AGENTATION_EVENT_RETENTION_DAYS` days (default 30).

## Troubleshooting

| Symptom | Cause |
|---|---|
| Extension: "The feedback service needs an update" / 404 on `/extension` | The server runs an older build — rebuild and restart the container |
| Extension: "Feedback isn't set up for this site" / 403 | The domain isn't registered, or was removed. Add it to a project's `--domains` (and restart Claude Code), or `agentation_enable_domain` |
| Extension: "Access was not accepted" / 401 | `ingestAuth` in the policy doesn't match `AGENTATION_INGEST_AUTH` |
| Side panel updates only every 20s | Server-sent events are blocked or buffered by the proxy — see the Nginx notes |
| `cloudflared` keeps restarting | Wrong `CLOUDFLARE_TUNNEL_TOKEN` — `docker compose logs cloudflared` says "Provided Tunnel token is not valid" |
| Cloudflare error 502 / 1033 | The tunnel's public hostname doesn't point to `http://agentation:4747`, or the server isn't healthy (`docker compose ps`) |
| Extension gets an HTML login page | Cloudflare Access is enabled on the hostname — remove it (see Cloudflare notes) |
| Claude Code sees no feedback | Check that `/mcp` shows `agentation` connected, and that `X-Agentation-Domains` (or `--domains`) match the hosts people use |
| Claude Code: "Dynamic Client Registration rejected" | The server is an older build without `X-Agentation-Auth` support — rebuild and restart it |

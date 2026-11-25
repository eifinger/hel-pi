# Hel-Pi

Hel-Pi keeps one conversation for one household. Every Home Assistant administrator who opens Hel-Pi, and every signed-in direct client, sees the same messages and attachments and can use the connected ChatGPT plan and any enabled tools. Only give access to people you trust with those permissions. By default, the assistant can only read chat attachments. It has no shell tool.

## Install from GitHub

Use Home Assistant OS on a 64-bit Intel/AMD or ARM system. In **Settings → About**, check that **Supervisor is 2026.11.0 or newer**: Hel-Pi relies on this version's server-side admin check for ingress. Update Supervisor before installing if needed. Home Assistant Container without Supervisor cannot install apps. The build needs internet access to Docker Hub and the npm registry. You do not need a GPU, an API key, or Tailscale to start.

1. As a Home Assistant administrator, [add the Hel-Pi repository](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Feifinger%2Fhel-pi). Alternatively, go to **Settings → Apps → Install app → ⋮ → Repositories** and add `https://github.com/eifinger/hel-pi`.
2. Select **Hel-Pi → Install → Start → Open web UI**. If Hel-Pi does not appear, select **Check for updates** in the store menu and refresh the page. For build errors, check **Settings → System → Logs → Supervisor**.
3. Optionally enable **Start on boot** and **Show in sidebar**. Keep protection mode enabled. There are no ports to forward.

For a local install instead, copy the whole `hel_pi` directory to the `local_apps` Samba share (or `/local_apps` in Terminal & SSH). Check that `local_apps/hel_pi/config.yaml` exists, check for updates, then select **Local apps → Hel-Pi**. A local copy and a repository install have different app identities and do not share chat data.

## Connect your ChatGPT plan

1. In the Hel-Pi page inside Home Assistant, select **Open sign-in**. In the new tab, sign in to OpenAI and authorize ChatGPT plan usage. You need an [eligible ChatGPT account](https://developers.openai.com/siwc/quickstart); an API billing account alone is not enough.
2. OpenAI redirects your browser to `http://localhost:1455/auth/callback?...`. It is normal for this page not to load: the app runs on Home Assistant, not on the computer that has your browser. Copy the **entire address**, return to the Hel-Pi tab, paste it into **Paste the redirect URL**, and select **Finish connection**. Never share this address or put it in a log. Start again if the ten-minute sign-in attempt expired.
3. Send a short message and wait for a reply. Hel-Pi selects the first model that OpenAI lists for your plan and the bundled Pi runtime supports. To reconnect after revocation or a restore, open **Account** in Home Assistant. Manage usage or revoke the grant in ChatGPT settings. No paid API-key fallback is configured.

Chat history and uploads are stored locally. Message context and files the model reads are sent to OpenAI for inference. Attach up to four files per message, at most 8 MiB each. The model can read text and supported images, not arbitrary documents or files on the host.

## Enable web tools (optional)

In **Hel-Pi → Configuration**, show optional settings, choose a **Web search provider**, save, and restart:

- **chatgpt** uses the connected account and currently selected model. Each search makes a separate request against your plan. [OpenAI limits hosted web search by model and account or workspace policy](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). If OpenAI rejects a search, ordinary chat still works. Hel-Pi does not switch to a paid API key or Brave automatically.
- **brave** sends the search query to Brave. Set **Brave Search API key** to a key from your [Brave Search API account](https://brave.com/search/api/). Brave usage is separate from ChatGPT usage.
- **Read public web pages** is independent of search and needs no API key. Hel-Pi fetches the page from your network and sends its text to the model. It accepts public IPv4 sites on standard HTTPS, checks redirects, and reads at most 1 MiB of HTML or plain text. It does not use cookies, run scripts, or open private addresses.

Try “Search for the latest Home Assistant release and cite the source” or, with page reading on, “Summarize https://www.home-assistant.io/blog/”. Search providers receive model-generated queries, which can contain chat context. Web pages and search results are untrusted; keep permissions narrow if MCP is also enabled.

## Connect the Home Assistant MCP server (optional)

Hel-Pi connects to **one** trusted Streamable HTTP MCP endpoint. The model cannot set the endpoint or its credentials. No hosted OpenAI connector, public tunnel, or Supervisor API access is needed.

1. Enable the [Model Context Protocol **Server** integration](https://www.home-assistant.io/integrations/mcp_server/) in Home Assistant. Limit the tools and entities you expose; use read-only mode if your version offers it. Create a long-lived access token under the chosen HA user's **Profile → Security**. Prefer a dedicated, non-admin user and grant only the endpoint access it needs.
2. In **Hel-Pi → Configuration**, enter the **MCP server URL** and **MCP bearer token**. Use Core's internal port: `http://homeassistant/api/mcp` on port 80, or `http://homeassistant:8123/api/mcp` on port 8123. If Core uses TLS, use its trusted HTTPS URL instead. The main endpoint can require an admin by default; configure it for the dedicated user and selected tools, or use a narrower endpoint supported by your HA version.
3. Leave **Permitted MCP tools** empty, save, restart, and ask “List the tools my Home Assistant MCP server offers.” This can discover names but cannot call any of them. To read exposed entity states, add the exact name the server lists (for example, `homeassistant__GetLiveContext`), save, restart, and ask about a specific exposed light. Add other names separated by commas only if needed.

Anyone who can use this chat can call the tools you permit, with the token owner's authority. MCP tool output (including entity names and state) goes to the model. There is no per-call approval screen. Leave control tools off unless you accept that risk. Remove the URL and restart to disable MCP; revoke the token in Home Assistant if you no longer need it. Hel-Pi does not run local MCP commands or perform OAuth for MCP servers.

## Enable private Tailscale access (optional)

Home Assistant ingress continues to work at your usual Home Assistant address without Tailscale. This app does not make Home Assistant remotely reachable. Remote ingress still needs a route you already use, such as Home Assistant Cloud. **Only the separate Hel-Pi address needs the Tailscale client connected.**

1. Enable **MagicDNS** and **HTTPS Certificates** in your [tailnet DNS settings](https://login.tailscale.com/admin/dns). HTTPS certificate names appear in public certificate transparency logs; the service itself stays private. The app does not use Funnel. You do not need to install the community Tailscale app, enable subnet routing, or open a router port.
2. In **Hel-Pi → Configuration**, show optional settings. Set **Direct access key** (`direct_access_key`) to a random secret of at least 32 characters from your password manager. This is a Hel-Pi password, **not** a Tailscale auth key or OpenAI token. Save and restart the app.
3. Open the Hel-Pi **Log** tab. Follow the Tailscale login link and authorize the new **hel-pi** machine in your own tailnet. Do not share the link. If you miss the pairing window, restart the app. If your tailnet requires device approval, approve this node. Limit access to TCP 443 on this node to your intended users/devices in your tailnet policy.
4. From a Tailscale-connected device, open **`https://` plus the machine's full DNS name** from the [Machines page](https://login.tailscale.com/admin/machines), for example `https://hel-pi.example-tailnet.ts.net`. Enter the direct access key. You should see the same chat as in Home Assistant. If HTTPS fails, check the actual assigned name, the node's approval and expiry, your access policy, the tailnet DNS settings, and the Hel-Pi log.

To invalidate direct sessions, change the key and restart. To disable Tailscale, remove the key and restart. Remove the machine from your tailnet too if you are retiring this installation. The direct endpoint permits chat and uploads, not OpenAI account setup.

## Back up and restore

In **Settings → System → Backups**, include **Hel-Pi** in the backup, and check that your automatic backup includes new apps. For local installations, also keep the installation ZIP or back up the local apps source folder. Store an encrypted backup off the Home Assistant device and keep the backup emergency kit separately.

Supervisor briefly stops Hel-Pi for a consistent backup, then restarts it if it was running. Back up between replies. The app's `/data/piko` holds its chat database, files, model settings, OpenAI refresh credentials and, when enabled, the Tailscale device identity. The backup also contains app options, including any direct access key, Brave key, and MCP token. Treat it like a password vault.

Restore Hel-Pi from the backup to the **same app identity** (the same repository, or the same local app). Start it and check an old message and attachment. Do not run a restored copy and the original at the same time: they share a Tailscale identity and OpenAI refresh token. If a restored grant is no longer valid, reconnect in **Account**; this does not clear history. Do not uninstall the app to troubleshoot: uninstalling can delete its data.

# Hel-Pi

Hel-Pi keeps one workspace for a household. The main chat and side chats have separate histories, not separate owners. Every Home Assistant administrator who opens Hel-Pi, and every signed-in direct client, can read the chats and household wiki, manage connections, approve tools and schedule work. Give access only to people you trust with those permissions. The assistant has no shell or arbitrary file access.

## Install from GitHub

Use Home Assistant OS on a 64-bit Intel/AMD or ARM system. In **Settings → About**, check that **Supervisor is 2026.11.0 or newer**: Hel-Pi relies on this version's server-side admin check for ingress. Update Supervisor before installing if needed. Home Assistant Container without Supervisor cannot install apps. The build needs internet access to Docker Hub and the npm registry. You do not need a GPU, an API key, or Tailscale to start.

1. As a Home Assistant administrator, [add the Hel-Pi repository](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Feifinger%2Fhel-pi). Alternatively, go to **Settings → Apps → Install app → ⋮ → Repositories** and add `https://github.com/eifinger/hel-pi`.
2. Select **Hel-Pi → Install → Start → Open web UI**. If Hel-Pi does not appear, select **Check for updates** in the store menu and refresh the page. For build errors, check **Settings → System → Logs → Supervisor**.
3. Optionally enable **Start on boot** and **Show in sidebar**. Keep protection mode enabled. There are no ports to forward.

For a local install instead, copy the whole `hel_pi` directory to the `local_apps` Samba share (or `/local_apps` in Terminal & SSH). Check that `local_apps/hel_pi/config.yaml` exists, check for updates, then select **Local apps → Hel-Pi**. A local copy and a repository install have different app identities and do not share chat data.

## Connect your ChatGPT plan

1. In Hel-Pi, open ChatGPT sign-in. In the new tab, sign in to OpenAI and authorize ChatGPT plan usage. You need an [eligible ChatGPT account](https://developers.openai.com/siwc/quickstart); an API billing account alone is not enough.
2. OpenAI redirects your browser to `http://localhost:1455/auth/callback?...`. It is normal for this page not to load: the app runs on Home Assistant, not on the computer that has your browser. Copy the **entire address**, return to the Hel-Pi tab, paste it into **Paste the redirect URL**, and select **Finish connection**. Never share this address or put it in a log. Start again if the ten-minute sign-in attempt expired.
3. Send a short message and wait for a reply. Hel-Pi selects the first model that OpenAI lists for your plan and the bundled Pi runtime supports. To reconnect after revocation or a restore, open **Connections**. Manage usage or revoke the grant in ChatGPT settings. No paid API-key fallback is configured.

Chat history and uploads are stored locally. Message context and files the model reads are sent to OpenAI for inference. Attach up to four files per message, at most 8 MiB each. The model can read text and supported images, not arbitrary documents or files on the host.

Ask Hel-Pi to draw a logo or diagram in chat. A complete SVG in a `svg` code block appears as a picture; select **SVG source** to read the code. Uploaded and sent PNG, JPEG, GIF and WebP files appear beside their download links. Chat does not automatically load remote images or run HTML widgets.

## Browse and edit household memory

Open **Memories → Household wiki**. Follow links from the index to pages about household topics, such as where you keep spare parts. Select **Edit page** to correct the Markdown, or **New page** to add a topic. The UI and assistant read the same files under `workspace/wiki/`. Chat consults these pages when relevant; they are not all sent with every message. A fresh wiki can be empty. You do not have to wait for Hel-Pi to create the first page.

Open **Notes & instructions** for two other kinds of memory. **Long-term memory** (`workspace/MEMORY.md`) holds stable facts and preferences and goes to the model with each chat request. Ask in the main chat to remember or correct a fact immediately. **Daily notes** (`workspace/memory/YYYY-MM-DD.md`) hold dated events and are read on demand. You can edit both. A stale edit does not overwrite a newer one: copy your draft before loading the latest version and merging your changes.

After 30 minutes of main-chat inactivity, two independent background reviewers can update these files: one maintains notes and long-term memory; the other maintains the wiki index and topic pages. Normally they need three new user messages, or enough text to fill a review batch. Either reviewer can decide that nothing is worth saving. They do not backfill older conversations or read side chats. They use your model allowance. Do not store credentials in memory. Removing text does not erase chat history, prior model requests or backups.

If **Automatic wiki review paused** appears, Hel-Pi cannot tell whether a write finished. Inspect the batch and the affected pages, correct them if needed, then select **Skip this batch** to resume. Hel-Pi will not retry or undo that write. Newer messages remain eligible. If an older installation no longer has the batch record, the wiki offers a separate **Skip through entry** action. Check the displayed boundary before confirming: it can also skip review of newer messages up to that entry. Neither action deletes chat history.

In **Notes & instructions → Assistant instructions**, set Hel-Pi’s behavior and style. Changes apply to subsequent chat requests. Save an empty field to restore the default. Alternatively, set **Assistant instructions** (`assistant_instructions`) in **Home Assistant → Hel-Pi → Configuration**, save, and restart the app. A nonblank Home Assistant setting takes precedence and makes the in-app instructions read-only. Clearing that setting and restarting restores your last in-app choice. Instructions and facts do not grant tool permissions.

`workspace/AGENTS.md` stores the editable assistant instructions. Chat and background review cannot write this file. **Before upgrading from 0.1.0**, check any custom `AGENTS.md`, `MEMORY.md` and dated notes: previously inactive material becomes available to the model. Only the two unmodified 0.1.0 starter templates are reset. There are no separate `SOUL.md` or `USER.md` inputs.

Main and side chats read the effective instructions and long-term memory before each model request. The limit is **64 KiB (65,536 bytes) per file**. If either file is larger, chat names the file it ignored; the other file still applies. Hel-Pi does not truncate or overwrite the oversized file. Shorten it in the workspace. The next request uses it without a restart, unless the Home Assistant instructions override is active for `AGENTS.md`.

## Use the assistant workspace

- **Side chats** start with a separate transcript but share instructions, long-term memory and workspace files. Use **Chat actions** to search the current conversation or compact its model context. Compaction is not a command to erase history.
- **Tasks** can run on demand, once or on a recurring schedule. Ask in the main chat or select **New task**. Read the result in the task’s execution history. A scheduled job can use enabled services without you being present; review its instructions and MCP permissions first.
- **Posts** are private reading suggestions based on household context. Hel-Pi attempts one at 07:00 in the app’s local time while running, or when you request one. It can skip publication. With web tools enabled it can also send search queries or page URLs to the selected service. Posts do not publish to another account.
- **Model settings** selects the conversation and background models. By default tasks, Posts and memory review use the conversation model. Background work can consume your allowance even when the browser is closed.
- **Skills** shows Markdown guides, including the built-in workspace guide. Ask Hel-Pi to save a reusable procedure as a skill. A skill gives instructions; it cannot execute a script or grant service access. Use **Tools** for reviewable JavaScript and **Connections** for credentials.
- **Artifacts** holds finished files. Browse, preview supported formats or download a file. If Hel-Pi sends an artifact in chat, the attachment is a snapshot; later edits to the artifact do not change it.

## Enable web tools (optional)

In **Hel-Pi → Configuration**, show optional settings, choose a **Web search provider**, save, and restart:

- **chatgpt** uses the connected account and currently selected model. Each search makes a separate request against your plan. [OpenAI limits hosted web search by model and account or workspace policy](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). If OpenAI rejects a search, ordinary chat still works. Hel-Pi does not switch to a paid API key or Brave automatically.
- **brave** sends the search query to Brave. Set **Brave Search API key** to a key from your [Brave Search API account](https://brave.com/search/api/). Brave usage is separate from ChatGPT usage.
- **exa**, **tavily** and **deepseek** use the matching provider key and send the search query to that provider. No provider is selected automatically and a failed search does not fall back to another provider.
- **Web page extraction provider** is independent of search. **built-in** needs no key: Hel-Pi fetches a public IPv4 HTTPS page from your network, checks redirects, and reads at most 1 MiB of HTML or plain text. It does not use cookies or run scripts. **firecrawl**, **exa** and **deepseek** send the public URL to the selected provider using its key; that provider fetches it from its own network. In either case the extracted content can go to the model. The old **Read public web pages** switch selects the built-in reader only when no extractor is explicitly set.

Try “Search for the latest Home Assistant release and cite the source” or, with page reading on, “Summarize https://www.home-assistant.io/blog/”. Search providers receive model-generated queries, which can contain chat context. Web pages and search results are untrusted; keep permissions narrow if MCP is also enabled.

## Connect the Home Assistant MCP server (optional)

Add each trusted Streamable HTTP MCP server as a separate named connection. The model cannot set the endpoint or its credentials. No hosted OpenAI connector, public tunnel, or Supervisor API access is needed.

1. Enable the [Model Context Protocol **Server** integration](https://www.home-assistant.io/integrations/mcp_server/) in Home Assistant. Limit the tools and entities you expose; use read-only mode if your version offers it. Create a long-lived access token under the chosen HA user's **Profile → Security**. Prefer a dedicated, non-admin user and grant only the endpoint access it needs.
2. In **Hel-Pi → Connections**, add an MCP connection with a name, endpoint URL and bearer token. Use Core's internal port: `http://homeassistant/api/mcp` on port 80, or `http://homeassistant:8123/api/mcp` on port 8123. If Core uses TLS, use its trusted HTTPS URL instead. The main endpoint can require an admin by default; configure it for the dedicated user and selected tools, or use a narrower endpoint supported by your HA version.
3. Discover the server's tools, then enable only the exact tools you want (for example, `homeassistant__GetLiveContext`). Ask about a specific exposed light. Discovery does not grant permission. Another server with an identically named tool has its own permissions. Changes take effect without restarting.

MCP tool output (including entity names and state) goes to the model. There is no per-call approval screen. Leave control tools off unless you accept that risk. Delete the connection to disable it and revoke the token at the service if you no longer need it. Hel-Pi does not run local MCP commands or perform OAuth for MCP servers. Upgrading from 0.1.0 imports the old MCP URL, token and allowed names once; after you verify the import, clear the legacy options. Subsequent option edits do not override Connections.

## Teach Hel-Pi an inventory tool

1. In **Connections**, add an HTTP connection named `Inventory`. Use your service’s HTTPS API base URL and, if required, a read-only bearer token or `X-API-Key`. Use a narrow base path such as `/api/inventory`. The base URL and secret are separate. Test sends a `HEAD` request to the base URL; a service that does not implement `HEAD` can still support tool requests.
2. Give Hel-Pi the API documentation in chat, **not your token**. For example: “Draft `find_item` using Inventory. `GET /items?q=…` returns an array of items with a `location`. Use a cable in the top drawer as sample data.”
3. Open **Tools** and select the draft. Read the source, selected connection, and changes from the active version. Test with sample input and fixture responses. A sample test does not contact the service or verify its API. Approve the displayed revision to allow live calls. A later draft does not replace the active version until you approve it.
4. Ask “Where is my spare cable?” Approved JavaScript can transform JSON and make GET requests under its bound connection’s base URL. It cannot read the token, follow redirects, or use arbitrary network destinations. Use a service that treats GET as read-only. Results returned to chat go to the model. Disable the active tool to stop future calls. Deleting and recreating a connection does not give the replacement access to old tools.

## Enable private Tailscale access (optional)

Home Assistant ingress continues to work at your usual Home Assistant address without Tailscale. This app does not make Home Assistant remotely reachable. Remote ingress still needs a route you already use, such as Home Assistant Cloud. **Only the separate Hel-Pi address needs the Tailscale client connected.**

1. Enable **MagicDNS** and **HTTPS Certificates** in your [tailnet DNS settings](https://login.tailscale.com/admin/dns). HTTPS certificate names appear in public certificate transparency logs; the service itself stays private. The app does not use Funnel. You do not need to install the community Tailscale app, enable subnet routing, or open a router port.
2. In **Hel-Pi → Configuration**, show optional settings. Set **Direct access key** (`direct_access_key`) to a random secret of at least 32 characters from your password manager. This is a Hel-Pi password, **not** a Tailscale auth key or OpenAI token. Save and restart the app.
3. Open the Hel-Pi **Log** tab. Follow the Tailscale login link and authorize the new **hel-pi** machine in your own tailnet. Do not share the link. If you miss the pairing window, restart the app. If your tailnet requires device approval, approve this node. Limit access to TCP 443 on this node to your intended users/devices in your tailnet policy.
4. From a Tailscale-connected device, open **`https://` plus the machine's full DNS name** from the [Machines page](https://login.tailscale.com/admin/machines), for example `https://hel-pi.example-tailnet.ts.net`. Enter the direct access key. You should see the same chat as in Home Assistant. If HTTPS fails, check the actual assigned name, the node's approval and expiry, your access policy, the tailnet DNS settings, and the Hel-Pi log.

To invalidate direct sessions, change the key and restart. To disable Tailscale, remove the key and restart. Remove the machine from your tailnet too if you are retiring this installation. A signed-in direct client has the same management access as a Home Assistant administrator opening Hel-Pi through ingress; tailnet membership alone does not sign a client in. If you shared the 0.1.0 direct key with chat-only users, rotate or remove it **before** upgrading.

## Back up and restore

In **Settings → System → Backups**, include **Hel-Pi** in the backup, and check that your automatic backup includes new apps. For local installations, also keep the installation ZIP or back up the local apps source folder. Store an encrypted backup off the Home Assistant device and keep the backup emergency kit separately.

Supervisor briefly stops Hel-Pi for a consistent backup, then restarts it if it was running. Back up between jobs and replies. The app's `/data/piko` holds the SQLite database (`state/durable/session.sqlite`) for chats, tasks, Posts and review progress; the `workspace/` directory for wiki pages, notes, instructions, local skills and artifacts; and `state/attachments/` for uploads and sent files. Local tool versions, connection credentials, model settings, OpenAI refresh credentials and the optional Tailscale device identity are also included. The backup contains app options, including any direct access key or search provider keys. Treat it like a password vault.

Restore Hel-Pi from the backup to the **same app identity** (the same repository, or the same local app). Start it and check an old message and attachment. Do not run a restored copy and the original at the same time: they share a Tailscale identity and OpenAI refresh token. If a restored grant is no longer valid, reconnect in **Connections**; this does not clear history. Do not uninstall the app to troubleshoot: uninstalling can delete its data.

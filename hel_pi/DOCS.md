# Hel-Pi

Hel-Pi keeps one conversation for one household. Every Home Assistant administrator who opens Hel-Pi, and every signed-in direct client, sees the same messages and attachments and can use the connected ChatGPT plan. Only use it with people you trust with that account's allowance. It cannot control devices or run shell commands.

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

## Enable private Tailscale access (optional)

Home Assistant ingress continues to work at your usual Home Assistant address without Tailscale. This app does not make Home Assistant remotely reachable. Remote ingress still needs a route you already use, such as Home Assistant Cloud. **Only the separate Hel-Pi address needs the Tailscale client connected.**

1. Enable **MagicDNS** and **HTTPS Certificates** in your [tailnet DNS settings](https://login.tailscale.com/admin/dns). HTTPS certificate names appear in public certificate transparency logs; the service itself stays private. The app does not use Funnel. You do not need to install the community Tailscale app, enable subnet routing, or open a router port.
2. In **Hel-Pi → Configuration**, show optional settings. Set **Direct access key** (`direct_access_key`) to a random secret of at least 32 characters from your password manager. This is a Hel-Pi password, **not** a Tailscale auth key or OpenAI token. Save and restart the app.
3. Open the Hel-Pi **Log** tab. Follow the Tailscale login link and authorize the new **hel-pi** machine in your own tailnet. Do not share the link. If you miss the pairing window, restart the app. If your tailnet requires device approval, approve this node. Limit access to TCP 443 on this node to your intended users/devices in your tailnet policy.
4. From a Tailscale-connected device, open **`https://` plus the machine's full DNS name** from the [Machines page](https://login.tailscale.com/admin/machines), for example `https://hel-pi.example-tailnet.ts.net`. Enter the direct access key. You should see the same chat as in Home Assistant. If HTTPS fails, check the actual assigned name, the node's approval and expiry, your access policy, the tailnet DNS settings, and the Hel-Pi log.

To invalidate direct sessions, change the key and restart. To disable Tailscale, remove the key and restart. Remove the machine from your tailnet too if you are retiring this installation. The direct endpoint permits chat and uploads, not OpenAI account setup.

## Back up and restore

In **Settings → System → Backups**, include **Hel-Pi** in the backup, and check that your automatic backup includes new apps. For local installations, also keep the installation ZIP or back up the local apps source folder. Store an encrypted backup off the Home Assistant device and keep the backup emergency kit separately.

Supervisor briefly stops Hel-Pi for a consistent backup, then restarts it if it was running. Back up between replies. The app's `/data/piko` holds its chat database, files, model settings, OpenAI refresh credentials and, when enabled, the Tailscale device identity. The backup also contains app options, including the direct access key. Treat it like a password vault.

Restore Hel-Pi from the backup to the **same app identity** (the same repository, or the same local app). Start it and check an old message and attachment. Do not run a restored copy and the original at the same time: they share a Tailscale identity and OpenAI refresh token. If a restored grant is no longer valid, reconnect in **Account**; this does not clear history. Do not uninstall the app to troubleshoot: uninstalling can delete its data.

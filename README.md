# Hel-Pi

Hel-Pi is a personal assistant with persistent memory for Home Assistant OS. Open **Memories** to browse and edit your household wiki. Hel-Pi organizes useful information from the main chat into linked Markdown pages. It also keeps dated notes and long-term preferences. You can set its instructions in Hel-Pi or in the Home Assistant app configuration.

Use an eligible ChatGPT subscription through Home Assistant ingress or sign in over Tailscale. Both routes have the same permissions. Start a side chat for a separate topic, schedule a task, read a private Post, or download a finished artifact. Hel-Pi can follow local Markdown skills, search the web, and call permitted MCP tools. You can also teach it JavaScript tools for your own HTTP services. Review and test the code before approving it; your tools and credentials stay in the app’s backup, not this repository.

[Add the Hel-Pi repository to Home Assistant](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Feifinger%2Fhel-pi), then select **Hel-Pi → Install**. See the [installation and account guide](hel_pi/DOCS.md) for requirements, Tailscale, and backups.

For development, run `.agents/setup`, then `bun run typecheck` and `bun test` in `hel_pi/`. The tests use local fixtures, not a ChatGPT account. To test packaging, install `hel_pi/` as a local app in the [official disposable Home Assistant app development environment](https://developers.home-assistant.io/docs/apps/testing/) and use the same steps as on Home Assistant OS.

Hel-Pi adapts [Piko](https://github.com/dandkong/piko/tree/bfe1a2149d2927b912800c924d29c18c947c54b8)’s Pi Durable runtime and assistant features. The Home Assistant packaging, access controls and browser client are specific to Hel-Pi. It does not include Telegram, Expo, general subagent delegation, a shell, or unrestricted file access. Hel-Pi is maintained independently under the [MIT license](LICENSE).

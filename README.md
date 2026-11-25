# Hel-Pi

Hel-Pi is a personal assistant with persistent memory for Home Assistant OS. It stores your conversation history and attachments locally, so you can pick up where you left off after a restart.

Use Hel-Pi in your browser through Home Assistant ingress, or connect directly over Tailscale. It uses an eligible ChatGPT subscription. Optional tools can search with ChatGPT or Brave, read public web pages, and call selected tools on an MCP server such as Home Assistant.

[Add the Hel-Pi repository to Home Assistant](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Feifinger%2Fhel-pi), then select **Hel-Pi → Install**. See the [installation and account guide](hel_pi/DOCS.md) for requirements, Tailscale, and backups.

For development, run `.agents/setup`, then `bun run typecheck` and `bun test` in `hel_pi/`. The tests use local fixtures, not a ChatGPT account. To test packaging, install `hel_pi/` as a local app in the [official disposable Home Assistant app development environment](https://developers.home-assistant.io/docs/apps/testing/) and use the same steps as on Home Assistant OS.

Hel-Pi builds on [Piko](https://github.com/dandkong/piko/tree/bfe1a2149d2927b912800c924d29c18c947c54b8). Its chat, attachment storage, and Pi Durable runtime are adapted from the work of the Piko contributors. Hel-Pi is maintained independently under the [MIT license](LICENSE).

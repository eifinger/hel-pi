# Hel-Pi

A single persistent [Piko](https://github.com/dandkong/piko) chat for Home Assistant OS. Use Home Assistant ingress in your browser, or optionally connect directly over Tailscale. Hel-Pi uses an eligible ChatGPT subscription and does not control Home Assistant devices.

[Add the Hel-Pi repository to Home Assistant](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Feifinger%2Fhel-pi), then select **Hel-Pi → Install**. See the [installation and account guide](hel_pi/DOCS.md) for requirements, Tailscale, and backups.

For development, run `.agents/setup`, then `bun run typecheck` and `bun test` in `hel_pi/piko/`. The tests use local fixtures, not a ChatGPT account. To test packaging, install `hel_pi/` as a local app in the [official disposable Home Assistant app development environment](https://developers.home-assistant.io/docs/apps/testing/) and use the same steps as on Home Assistant OS.

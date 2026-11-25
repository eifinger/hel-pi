FROM tailscale/tailscale:v1.104.7 AS tailscale
FROM oven/bun:1.4.4
WORKDIR /opt/hel-pi/piko
COPY piko/package.json piko/bun.lock ./
RUN bun install --frozen-lockfile --production && bun pm cache rm
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/containerboot /usr/local/bin/
COPY serve.json ../serve.json
COPY piko/server ./server
COPY piko/shared ./shared
COPY piko/LICENSE ./LICENSE
COPY web ../web
# A local app may arrive over Samba or be extracted with umask 077.
# Make packaged source readable by bun without giving it ownership or touching /data.
RUN chmod -R a+rX server shared ../web && chmod a+r package.json ../serve.json
COPY run.sh /usr/local/bin/start-hel-pi
ENTRYPOINT ["/bin/sh", "/usr/local/bin/start-hel-pi"]

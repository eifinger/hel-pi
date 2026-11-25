#!/bin/sh
set -eu
umask 077
unset SUPERVISOR_TOKEN HASSIO_TOKEN
# Lock the data mount before touching restored files. The service inherits this descriptor.
exec 9</data
flock --nonblock 9
test ! -L /data/piko
install -d -m 0700 -o bun -g bun /data/piko /run/hel-pi
# Supervisor can restore descendants as root. Never follow symlinks or cross mounts.
find -P /data/piko -xdev \( -type d -o -type f \) \( ! -user bun -o ! -group bun \) -exec chown -h bun:bun {} +
find -P /data/piko -xdev -type d ! -perm 0700 -exec chmod 0700 {} +
find -P /data/piko -xdev -type f ! -perm 0600 -exec chmod 0600 {} +
# Supervisor owns /data/options.json. Give the service only its own options.
install -m 0400 -o bun -g bun /data/options.json /run/hel-pi/options.json
chmod o+x /data
exec setpriv --reuid=bun --regid=bun --clear-groups --no-new-privs \
  bun server/hel-pi/index.ts

#!/bin/sh
# Started as root only to hand DATA_DIR to the `node` user (volumes from images before 1.0 are root-owned, and a
# `docker exec` run as root can leave a file behind), then the app runs as `node`, still PID 1 for SIGTERM.
set -e
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA_DIR"
  # -h: a symlink itself, never its target. A volume that refuses chown (NFS root_squash, some SMB mounts) only warns:
  # under set -e it would stop the container before the app could say what it can't write.
  find "$DATA_DIR" ! -user node -exec chown -h node:node {} + ||
    echo "diffnotes: could not give $DATA_DIR to the node user; the app may not be able to write it" >&2
  exec su-exec node "$@"
fi
exec "$@"

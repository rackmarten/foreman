# syntax=docker/dockerfile:1
#
# foreman's runner as a container image. One image runs
# every service in docker-compose.yml (dispatch, chat, pipeline, housekeeping);
# only the command differs. Nothing environment-specific is baked in: hosts,
# credentials and the workspace clone all arrive through env_file and mounts,
# see .env.example for the full contract.

FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# gid of the host's `docker` group, so the non-root user can use the mounted
# /var/run/docker.sock. Check it with `getent group docker` on the host.
ARG DOCKER_GID=991
ARG CLAUDE_CODE_VERSION=2.1.284

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# What the work CLI shells out to (git, gh, ssh, cp) plus what the scripts it
# runs need: this repo's scripts/ (curl, python3, pgrep) and the workspace's
# deploy-service.sh/deploy-steps.sh (git, gh, ssh, curl, python3, docker).
# Docker is the CLI and plugins only; the daemon is the host's, via the socket.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/* \
 && arch="$(dpkg --print-architecture)" \
 && echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client python3 procps sudo less \
      gh docker-ce-cli docker-compose-plugin docker-buildx-plugin \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# The base image's `node` user already holds uid/gid 1000; rename it to marek
# rather than adding a second uid 1000. Its home is the persistent
# /app/state/home, in passwd as well as $HOME: ssh reads ~/.ssh
# from the passwd entry and ignores $HOME. Passwordless sudo is decision 5 in
# #514: the container is disposable, and a prompted sudo is useless to an
# unattended session. It is root inside this container only.
RUN groupmod -n marek node \
 && mkdir -p /app/state \
 && usermod -l marek -d /app/state/home -m node \
 && groupadd -g "${DOCKER_GID}" docker \
 && usermod -aG docker marek \
 && echo 'marek ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/marek \
 && chmod 0440 /etc/sudoers.d/marek

# git over https authenticates with GH_TOKEN through gh (decision 3 in #514).
# git@github.com remotes are rewritten to https too, so GitHub
# never sees the SSH key in state/home/.ssh (that key is for the LXCs only).
RUN git config --system credential.https://github.com.helper '' \
 && git config --system --add credential.https://github.com.helper '!/usr/bin/gh auth git-credential' \
 && git config --system --add url.https://github.com/.insteadOf 'git@github.com:' \
 && git config --system --add url.https://github.com/.insteadOf 'ssh://git@github.com/'

# Pinned so a rebuild is reproducible; the image is the update path now, not
# `claude update` (which cannot write to the root-owned global prefix anyway).
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1

# The work CLI, built into the image and put on PATH directly: no `npm link`
# against a mounted checkout, so the README's "two clones, one npm link"
# gotcha has nothing to act on here.
WORKDIR /app/app
COPY app/package.json app/package-lock.json ./
# Public registry only: no token at build time.
RUN npm ci \
 && npm cache clean --force
COPY app/tsconfig.json ./
COPY app/src ./src
RUN npm run build \
 && npm prune --omit=dev \
 && chmod 0755 dist/work.js \
 && ln -s /app/app/dist/work.js /usr/local/bin/work

WORKDIR /app
COPY scripts ./scripts

# Mount points (see docker-compose.yml). Created here so they are owned by
# marek, not root, when a named volume or an empty host path lands on them.
RUN mkdir -p /app/tasks /app/workspace /app/state /app/secrets \
 && chown marek:marek /app/tasks /app/workspace /app/state

# marek, numeric for hadolint DL3066. uid only: with an explicit gid Docker
# skips /etc/group and marek would lose the docker group (socket access).
USER 1000
ENV HOME=/app/state/home
CMD ["work", "--help"]

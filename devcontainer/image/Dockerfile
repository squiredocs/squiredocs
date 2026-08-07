# collab dev sandbox image. Debian-based (glibc) Node 22 — chosen over the
# production node:22-alpine (musl) so the isolated-vm build toolchain, gh, and
# Claude Code's installer all work without musl friction. Dev-only; does not
# affect the production image. node_modules are (re)built in-pod by npm, so the
# glibc/musl ABI difference vs prod never crosses environments.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive
# Don't write .pyc files; unbuffered IO so logs aren't lost on container kill.
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Base packages:
# - build-essential + python3: native-module builds (isolated-vm via node-gyp)
# - git: in-pod commits / gh
# - jq: handy for poking the MCP/JSON APIs (see docs/dev.md)
# - postgresql-client: psql against the in-cluster collab-postgres
# - procps: ps/pgrep used by restart's Claude-SIGTERM logic
# - tini: reaping PID 1 for the pod containers (see CMD below)
# - unzip: the AWS CLI installer below ships as a zip
RUN apt-get -yqq update \
    && apt-get -yqq --no-install-recommends install \
        build-essential python3 git jq ca-certificates curl gnupg \
        postgresql-client procps tini unzip \
    && apt-get -yqq clean && rm -rf /var/lib/apt/lists/*

# GitHub CLI from the official apt repo (not in Debian's default archive).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get -yqq update \
    && apt-get -yqq --no-install-recommends install gh \
    && apt-get -yqq clean && rm -rf /var/lib/apt/lists/*

# Claude Code CLI, baked in for in-pod agent sessions. Pinned — a floating
# version would let a transient claude.ai outage break image rebuilds. The pod
# runs as root, so it installs to /root/.local/bin; symlink onto PATH.
ARG CLAUDE_CODE_VERSION=2.1.118
RUN curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_CODE_VERSION" \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude

# kubectl + AWS CLI, for operating the prod squiredocs cluster from the pod
# (SSM onto nodes, o11y queries, deploys). Binaries only — credentials are
# never baked: kubeconfig and AWS sessions are provisioned into the running
# pod (`aws login`, SSM kubeconfig pull) and live in ephemeral /root. Both
# pinned like Claude Code so a transient upstream outage can't break rebuilds.
ARG KUBECTL_VERSION=v1.36.3
RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl" \
      -o /usr/local/bin/kubectl \
    && chmod 0755 /usr/local/bin/kubectl

# The AWS installer names arches x86_64/aarch64 (uname -m), not amd64/arm64.
ARG AWS_CLI_VERSION=2.36.13
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m)-${AWS_CLI_VERSION}.zip" \
      -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# `dev` — start the collab dev servers (Express + Vite). Baked so it's on PATH
# from the first shell.
COPY --chmod=0755 image/dev-servers.sh /usr/local/bin/dev

# Sandbox shell setup (`yolo`, the claude wrapper, .env autoload, cd $WORKSPACE).
# Baked into the image rather than appended to ~/.bashrc by postCreate because
# /root is ephemeral — every pod recreate resets it, and postCreate only runs
# from `up`. Sourced from /etc/bash.bashrc for interactive shells (what
# `kubectl exec -it ... bash` gets) and /etc/profile.d for login shells.
COPY --chmod=0755 image/shell-init.sh /etc/collab-devcontainer.sh
RUN echo '. /etc/collab-devcontainer.sh' >> /etc/bash.bashrc \
    && ln -sf /etc/collab-devcontainer.sh /etc/profile.d/collab-devcontainer.sh

# macOS hands out temp/screenshot paths under both /var/folders/... and the
# /private/var/folders/... realpath (/var -> /private/var on macOS). Host mounts
# land at /var/folders/...; symlink /private/var -> /var so a dragged path in the
# /private form resolves to the same mount. Baked in for the same reason as
# above: it's ephemeral container state that a pod recreate would drop.
RUN mkdir -p /private && ln -sfn /var /private/var

# The workspace is bind-synced and may be owned by a different uid than the
# shell; mark it safe so git doesn't refuse with "dubious ownership". Baked into
# the image's global gitconfig so it survives pod recreates.
#
# maintenance.autoDetach: git >= 2.47 detaches `maintenance run --auto` after
# every commit/fetch; under a non-reaping PID 1 each detached run becomes a
# permanent zombie (on liz-devcontainer 64k of them hit the nproc rlimit and
# killed fork() entirely — cto-tool 42fad95/0a3c314). Bookworm's git 2.39
# ignores the key today; it's armed for the day the base image's git crosses
# 2.47. tini as PID 1 (below) is the backstop for every other orphan source.
RUN git config --global --add safe.directory /local-dev \
    && git config --global maintenance.autoDetach false

# The pod runs this via k8s/app-dev.yaml too: `sleep infinity` as PID 1 never
# reaps orphans (this pod collected literal zombies — e.g. a defunct ssh), so
# tini sits in front as a reaping PID 1.
CMD ["tini", "--", "sleep", "infinity"]

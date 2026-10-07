# collab-devcontainer

Sandbox manager for the [collab](..) app (the collaborative rich-text editor / squiredocs). It hardens collab's existing **Minikube + Mutagen** dev pod into a versioned, one-command sandbox: a dedicated dev image with **Claude Code**, **GitHub CLI**, **kubectl + AWS CLI** (for prod ops from the pod), and the **isolated-vm build toolchain** baked in, plus a CLI that wraps the `kubectl` / `mutagen` / `port-forward` lifecycle.

It follows the **spirit** of [liz-devcontainer](https://github.com/Semalab/liz-devcontainer) — a hardened sandbox image, a one-command CLI, per-repo config — but not its mechanics. liz runs a docker-compose sandbox on the laptop; collab's dev substrate is Minikube, so the sandbox here runs **in the cluster as the `app-dev` pod**. That choice is deliberate: see [Compatibility with Minikube + Mutagen](#compatibility-with-minikube--mutagen).

## Where it lives

The tool lives **in-repo** at `devcontainer/` (it started life as the external [samg/collab-devcontainer](https://github.com/samg/collab-devcontainer) repo, modeled on liz-devcontainer's separate-repo pattern; collab commits straight to main, so the branch-collision rationale for a separate repo never applied). The CLI resolves its own lib/image/manifests from wherever its binary really lives, and finds the target repo's config by walking up from CWD — so being inside the repo changes nothing about how it runs.

## Install (one time per laptop)

```sh
<collab-checkout>/devcontainer/install
```

The install script symlinks `bin/collab-devcontainer` into `~/.local/bin/` and scaffolds `~/.config/collab-devcontainer/`. (No shell-env export is needed — there's no VS Code "Reopen in Container" compose path here.)

## Once per target repo

collab already ships a tracked **`collab-devcontainer.toml`** at its root, so a fresh clone just works. The CLI finds config by walking up from CWD, then falling back to `~/.config/collab-devcontainer/<repo-basename>.toml`. Key fields:

```toml
schema_version = 1
[target]
name = "collab"
workspace_mount = "/local-dev"     # matches the existing Mutagen target
[minikube]
context = "minikube"
namespace = "collab"
deployment = "app-dev"             # same name mutagen.sh / port-forward.sh target
postgres_service = "collab-postgres"
redis_service = "collab-redis"
[image]
name = "collab-dev:latest"
```

Prerequisites (the same ones collab's `docs/dev.md` lists): Minikube running, the `collab` namespace with `collab-postgres` + `collab-redis` deployed, `kubectl`, `mutagen`, and Docker.

## Daily use

```sh
cd ~/dev/collab
collab-devcontainer up          # build image (if needed) + apply pod + sync + port-forward + shell
collab-devcontainer shell       # extra terminal into the running pod
dev                             # inside pod: Express :3001 + Vite :5173 (then open http://localhost:5173)
collab-devcontainer install-deps# re-run npm ci (root + client) after a lockfile change
collab-devcontainer rebuild     # after editing image/Dockerfile or image/dev-servers.sh
collab-devcontainer restart     # recreate the pod (re-syncs Mutagen); Claude state persists on its PVC
collab-devcontainer mounts      # check/heal the host mounts (.git + drag-and-drop dirs)
collab-devcontainer doctor      # validate context, services, image, sync, paths
collab-devcontainer config      # print resolved config
```

`up` is idempotent — each step no-ops when its work is already done.

## What `up` does

1. **Guards the kube context** (refuses to run unless current context is `minikube`).
2. **Builds `collab-dev:latest`** into Minikube's Docker daemon if absent.
3. **Heals the host mounts** — before the pod, so its `hostPath` volumes bind onto live 9p mounts rather than empty directories.
4. **Applies** the Claude-config PVC and the `app-dev` pod manifest.
5. **Waits** for the pod to be ready, then **verifies the pod can actually see its mounts**, rebinding it if not (an unchanged manifest won't recreate a pod that came up before its mounts).
6. **Syncs Mutagen + installs deps** unless the existing `app-sync` session already targets *this* container: creates the sync against the `app` container, then runs `npm ci` in the isolated `installer` container.
7. **Seeds** host Claude skills/plugins/status-line onto the PVC.
8. **Runs postCreate** (idempotent, every time — see below).
9. **Starts port-forwards** for `:5173` and `:3001`.
10. **Execs** an interactive shell into the pod.

### Image vs. postCreate

Anything static about the shell — `yolo`, the `claude` API-key wrapper, `$PATH`, the `.env` autoload, `cd /local-dev`, git `safe.directory`, the `/private/var → /var` symlink — is baked into the **image** at `/etc/collab-devcontainer.sh` and sourced from `/etc/bash.bashrc`, so it survives every pod recreate and is present even in a bare `kubectl exec ... bash` that never touches this CLI.

It used to be appended to `/root/.bashrc` by postCreate, which was wrong twice over: `/root` is ephemeral, so a recreate reverted it; and postCreate ran only from `up`, behind a "once per pod" marker — so `restart`, a minikube restart, or a kubelet eviction silently produced a pod with no `yolo`. What remains in postCreate is only what depends on the PVC or host-seeded files (the `settings.json` merges, status-line wiring), and it now runs on every `up`/`restart` because it's cheap and idempotent.

## Compatibility with Minikube + Mutagen

This is the design center. The sandbox **is** an upgraded version of the `app-dev` pod collab already uses, so the new flow and the manual flow in `docs/dev.md` are the same thing:

- **Same deployment name/labels (`app-dev`).** collab's `script/port-forward.sh` and the `docs/dev.md` `kubectl exec` commands target `app-dev` and keep working (a `default-container: app` annotation routes bare `exec`/`cp` to the right container). The CLI produces the **same `app-sync` sync** to the same `/local-dev` — but creates it itself rather than calling `script/mutagen.sh` (see [Supply-chain isolation](#supply-chain-isolation)). The sync is interchangeable; run `collab-devcontainer up` against the enhanced pod rather than raw `script/mutagen.sh`.
- **Same workspace path (`/local-dev`).** Every cwd, script, and habit from `docs/dev.md` is identical inside the sandbox.
- **Same in-cluster DB access.** The pod reaches `collab-postgres` / `collab-redis` by Kube DNS — exactly as the manual pod does. **One database, no second dataset, no bridge.** You can `kubectl exec` into either and see the same rows.
- **Same secrets.** k8s injects `postgres-secret` (and optionally `ses-secret`); nothing new to manage on the host.
- **Same inner loop.** `npm run dev`, `npm test`, `npm run migrate` are unchanged.

The only thing the CLI adds on top is a better **image** (`collab-dev:latest` vs the prod `collab:latest`) and lifecycle automation. You can still drive everything by hand per `docs/dev.md`; the CLI is a convenience front-end, not a replacement substrate.

**`node_modules`:** installed in-pod (glibc, from the debian dev image), ignored by Mutagen — same as today. Nothing on the host tree is touched.

## Layout

```
collab-devcontainer/
├── bin/collab-devcontainer    # dispatcher
├── lib/
│   ├── common.sh              # toml parse, env export, kc()/require_context helpers
│   ├── cmd_up.sh              # build → apply → wait → sync → postCreate → forward → shell
│   ├── cmd_shell.sh  cmd_build.sh  cmd_rebuild.sh  cmd_restart.sh
│   ├── cmd_install_deps.sh    # npm ci (root + client) in the isolated installer container
│   ├── cmd_doctor.sh  cmd_config.sh
│   └── postcreate.sh          # in-pod first-launch (git safe.dir, .env, claude wrapper)
├── image/
│   ├── Dockerfile             # node:22-bookworm + build tools + gh + jq + Claude Code + kubectl + AWS CLI
│   └── dev-servers.sh         # baked at /usr/local/bin/dev (npm run dev)
├── k8s/
│   ├── app-dev.yaml           # hardened pod: app + no-secrets installer sidecar
│   └── claude-pvc.yaml        # persistent /root/.claude
├── install                    # symlink CLI, scaffold host config dir
└── README.md
```

## Claude Code state

The pod mounts a small PVC at `/root/.claude`, so `claude /login` and session history survive `restart`/`rebuild`. Run `claude` once and `/login`; you won't be asked again. `restart` prints recent `--resume` IDs (read from the PVC) before recreating the pod.

**Bypass-permissions mode (`yolo`):** the pod runs as root, and Claude Code normally refuses `--dangerously-skip-permissions` as root. Since the pod is an isolated sandbox, the manifest sets `IS_SANDBOX=1` (inherited by every shell), which re-enables it — and `/etc/collab-devcontainer.sh` (baked into the image, so it survives pod recreates) defines `yolo` as a shorthand for `claude --dangerously-skip-permissions`. Just run `yolo`.

**Host skills/plugins/status-line** are seeded into the pod automatically. A pod can't bind-mount host dirs the way liz's compose override does, so on every `up` the CLI `kubectl cp`s `~/.claude/skills`, `~/.claude/plugins`, and `~/.claude/statusline-command.sh` onto the PVC (the script keeps its executable bit). Author them on the host — in-pod edits are overwritten on the next `up`. `settings.json`, hooks, and permission rules are intentionally **not** copied: they carry host-specific paths/commands and host allow-rules that shouldn't leak into the pod.

The status-line script only **renders** if the pod's `settings.json` has `statusLine.command` pointing at `~/.claude/statusline-command.sh` — set that once in the pod (it persists on the PVC), since the CLI doesn't copy your host `settings.json`.

## Dragging files in (screenshots)

Drag-and-drop pastes a file's absolute host path, so the file must be readable at that *same* path inside the pod. A Kubernetes pod can't bind-mount host dirs directly, so the CLI uses `minikube mount` + `hostPath`: for each configured path, a `minikube mount <path>:<path>` runs on the host and the pod gets a read-only `hostPath` volume at the same path.

```toml
[mounts]
host_paths = "~/Desktop,~/Downloads"
```

Beyond `host_paths`, these are auto-added on macOS because they're machine-specific:

- the configured screenshot destination (`com.apple.screencapture location`), when changed from the default `~/Desktop`;
- **`$TMPDIR/TemporaryItems`** — where a screenshot lives *before* you save it. Dragging the floating thumbnail straight into the pod hands over a path that exists nowhere else on disk;
- `/private/tmp`, which some apps use to stage drag promises.

The whole of `$TMPDIR` is deliberately **not** mounted, even though it's the parent of `TemporaryItems`. minikube's 9p server can't serve a directory that large: listing it fails with `Unknown error 526`, and — worse — nothing under `TemporaryItems` is reachable through it at all, not even a file just created there. Mounted directly, `TemporaryItems` works fine. Mount the specific staging dirs, never their giant parent. A path nested inside another configured path is dropped automatically (and an old nested mount left over from a config change is torn down).

### Writable host dirs (`rw_paths`)

`host_paths` mounts are **read-only** — a drop dir only has to be readable, and the pod is the less-trusted side. To edit a host directory *from* the pod, list it in `rw_paths` instead:

```toml
[mounts]
host_paths = "~/Desktop,~/Downloads"      # read-only
rw_paths   = "~/dev/some-host-repo"       # read-write
```

Same mechanism, same absolute path inside the pod, same healing and auto-heal coverage — the only difference is that the `hostPath` volumeMount omits `readOnly: true`. (The 9p mount is always read-write; `readOnly` on the volumeMount is the sole thing enforcing the distinction.)

(The CLI itself used to be developed this way, as an external repo in `rw_paths`; now it lives in-repo at `devcontainer/` and rides the Mutagen sync like the rest of the tree, so collab's tracked toml ships `rw_paths` empty.)

Two things to know:

- **It's a real grant of write access.** Anything in `rw_paths` can be rewritten by whatever runs in the sandbox, including the CLI scripts that then execute on your host. Only list repos you'd let the pod modify.
- **It needs `up` or `restart` to take effect.** A running pod keeps whatever access its spec was created with, so adding a path to `rw_paths` doesn't reach an existing pod. `doctor` catches exactly this and says so rather than reporting the mount as fine.

A path listed in `rw_paths` but nested inside another mounted path is dropped by the usual nesting rule, leaving the read-only ancestor — `up` and `doctor` both warn instead of letting you find out via a permission error. An ancestor is never promoted to read-write, so putting `~/dev/foo` in `rw_paths` while `~/dev` sits in `host_paths` can't quietly make all of `~/dev` writable.

**macOS gotcha (TCC):** `~/Desktop`, `~/Downloads`, and `~/Documents` are privacy-protected by macOS, and the process serving the 9p mount is denied access to them by default — the mount appears but reads fail with *permission denied*. To use those folders, grant your terminal app **Full Disk Access** (System Settings → Privacy & Security → Full Disk Access → add iTerm/Terminal), then re-run `up`. Non-protected folders work without this. Alternatively, point screenshots at a non-protected dir (`defaults write com.apple.screencapture location ~/Screenshots`) and mount that instead.

### Keeping the mounts alive (`mounts`)

`minikube mount` establishes **one** 9p mount inside the node and never reconnects. A Mac reboot or `minikube stop/start` therefore breaks every mount, and it breaks them *quietly* — in two different ways:

| State | What you see | Fix |
|---|---|---|
| Host process alive, node mount gone | The classic post-reboot orphan. `pgrep` finds a healthy-looking process; the pod sees **empty** directories. | remount |
| Node mount entry present, no serving process | Every read returns `EIO` (`Unknown error 526`). The kubelet refuses to create the container at all — the pod is stuck in `CreateContainerError`. | force-unmount, then remount |
| Mount entry **and** process both present, but the export has gone bad | Everything looks perfect — table entry, live process — yet every read through the mount returns `EIO`, including files created on the host seconds ago. | force-unmount, then remount |

Because of the first case, liveness is **never** judged by `pgrep` alone. Because of the third, it isn't judged by the mount table either: a path counts as healthy only when the node has an entry, a host process is still serving it, **and the node can actually read through it** (one batched `minikube ssh` + `sudo stat` per run — `sudo` because the mounts are `--uid 0 --gid 0` and `minikube ssh` lands as the unprivileged `docker` user).

That third check is deliberately a `stat`, never a directory listing. A directory with thousands of entries overflows 9p's `readdir` and fails with `Unknown error 526` while the mount is perfectly usable for opening files *by path* — which is all a dragged-in path needs. Probing with `ls` classifies that working mount as broken and remounts it on every invocation.

```sh
collab-devcontainer mounts                  # heal whatever is down, then report
collab-devcontainer mounts --status         # report only, change nothing
collab-devcontainer mounts --install-agent  # heal automatically from now on
collab-devcontainer mounts --uninstall-agent
```

`--install-agent` writes a LaunchAgent (`~/Library/LaunchAgents/com.collab-devcontainer.mounts.<repo>.plist`) that runs at login and every 120s, logging to `~/Library/Logs/collab-devcontainer-mounts.log`. **This is what makes recovery automatic after a reboot** — minikube usually isn't running yet at login, so a one-shot at login isn't enough; the periodic tick catches the mounts once the node is back. The plist sets `AbandonProcessGroup`, without which launchd would SIGKILL the `minikube mount` children the moment the job exits, tearing down each mount right after establishing it.

The agent only ever touches mounts — it never recreates the pod, since that would interrupt whatever is running inside it. Reaping is scoped to this repo's configured paths, so other repos' `minikube mount` processes on the same machine are left alone.

Mount mutation is serialized with a lock (`$TMPDIR/devcontainer-mounts.<profile>.lock`, stale after 180s) so the agent's tick and a user-run command can't reap each other's freshly-started mounts. The name is keyed on the minikube profile rather than on this tool, because the node's mount table is shared with any sibling devcontainer CLI on the same profile — wft-devcontainer configures the same drop dirs and runs its own agent on the same tick, so a tool-scoped lock would not have interlocked them.

**Pods bind hostPath at creation.** If the pod started while a mount was down, healing the mount isn't always enough — propagation re-delivers a mount that simply reappeared, but not one that was unmounted and remounted under a running container. So `up` and `shell` check whether the pod can actually see its mounts and rebind it (a `restart`) when it can't. That check is why entering the sandbox after a reboot Just Works.

Recreating the pod **kills everything running inside it**, so it is the last resort, and it is only taken for faults it can actually fix. Each path the pod can't see is classified by asking the *node*:

| The node… | Meaning | Action |
|---|---|---|
| reads the path fine | The mount is live; only the pod's bind is stale. | rebind (a `restart`) |
| can't read it either | The mount itself is broken. | remount, and say so — **no** pod recreate |

Recreating the pod for the second case is what turned `shell` into an unconditional pod-killer: a bad 9p export made the check fail on every invocation, and each one "fixed" it with a restart that rebound the new pod onto the very same broken mount. A pod recreate can never repair a mount.

As a backstop, an automatic rebind is recorded in `$TMPDIR/devcontainer-rebind.<context>.<namespace>.<deployment>`. If the *same* set of paths is still unseen within 15 minutes of the last automatic recreate, the CLI refuses to recreate again and prints what to run instead — better a missing screenshot dir than a `shell` that kills the container every time. `collab-devcontainer restart` still forces it.

And even a fixable rebind ends every session in the pod, so when Claude is running there (most likely a live session in another terminal), `shell`/`up` ask before recreating and default to leaving the pod alone; without a TTY they only warn.

The pod's view is probed **by path, never by listing**: the CLI samples a few entry names the host actually has and asks the pod to resolve them (`[ -e "$dir/$name" ]`), for the same `readdir` reason as above. If those sampled entries vanish mid-probe — `TemporaryItems` churns constantly — the result is treated as inconclusive rather than as a fault, so a race can't trigger a recreate.

Blindness is judged **only against paths the pod actually declares a volumeMount for**. A desired path the pod never declared isn't a broken mount — it's a stale pod spec, which a rebind can't fix. (`$TMPDIR/TemporaryItems` only exists once a screenshot has been taken, and is gone again after a reboot, so it routinely joins the desired set after the last `up`.) Judging against the desired set instead would make every `shell` trigger another pointless restart, forever. For the same reason `restart` re-applies the manifest before rolling the pod, rather than reusing the existing template.

## In-pod git (the `.git` mount)

Claude Code and `gh` run **inside** the pod, so they need the repo's git history there — but `.git` is deliberately excluded from the Mutagen sync (two-way syncing a live `.git` invites corruption: lock files, `packed-refs`, and constant churn). Instead, when `[git].mount_dotgit` is set, `up` bind-mounts the host repo's `.git` into the pod via the same `minikube mount` + `hostPath` mechanism as the screenshot mounts — but **read-write**, and mapped to a *different* in-pod path (`<workspace_mount>/.git`, e.g. `/local-dev/.git`) so it sits where git expects it:

```toml
[git]
mount_dotgit = true
```

Because it's the host's *real* `.git`, the pod and host share one history: a `git commit` (or `gh pr create`) in the pod moves `HEAD` in the host checkout too. The working tree git sees is the Mutagen-synced copy at `/local-dev`, and `safe.directory` is pre-set there (postCreate), so `git status`/`log`/`commit`/`push` and `gh` work out of the box.

Caveats:

- **9p, like the screenshot mounts**, but git is more demanding (locking, atomic renames, thousands of small loose objects). Everyday operations are fine; heavy ones (`gc`, large checkouts) can be slow. It dies on a reboot exactly like the other mounts — an empty `/local-dev/.git` in the pod is that failure, not a corrupted repo. `collab-devcontainer mounts` heals it; `--install-agent` keeps it healed.
- **Working-tree-rewriting commands run *in* the pod** (`git checkout`, `reset --hard`, `stash`) rewrite `/local-dev`, which Mutagen then propagates back to the host working tree — the same end state as running them on the host, just with sync churn. Prefer running those on the host to avoid the round-trip.
- Only a `.git` **directory** is supported. A `.git` *file* (linked worktree or submodule pointer) is skipped — its real gitdir lives elsewhere and would need its own mount.

## Supply-chain isolation

Like liz-devcontainer, dependency installs run with **no secrets present**, so a malicious postinstall in a transitive dep can't read them. The `app-dev` pod has two containers:

- **`app`** — runs the dev servers and Claude; gets `postgres-secret` / `ses-secret` in its env and mounts the Claude PVC.
- **`installer`** — runs `npm ci`; shares the `/local-dev` volume so `node_modules` lands where `app` sees it, but mounts **none** of those secrets and shares no PID namespace with `app`. `install-deps` (and `up` on a fresh pod) exec there via `-c installer`.

A compromised postinstall therefore runs in a container with no DB/SES creds in its environment and no way to read `app`'s. (It could still write a trojan into `node_modules` that `app` later runs — true of any `npm install`; the goal here, as in liz, is protecting **secrets/identity**, not sandboxing arbitrary code.)

The cost of this isolation: a two-container pod breaks collab's `script/mutagen.sh` container lookup (`docker ps | grep app-dev` matches both), so the CLI **creates the `app-sync` sync itself** (targeting the `app` container by ID) instead of calling that script. The sync is byte-for-byte equivalent; just drive the enhanced pod with `collab-devcontainer up`, not raw `script/mutagen.sh`. The pure-manual flow (collab's stock single-container `k8s/app-dev.yaml`) is unaffected and still uses `script/mutagen.sh`.

## VS Code

The compose-based "Reopen in Container" flow doesn't apply (the sandbox is a Kube pod, not a compose service). Use **"Dev Containers: Attach to Running Container"** against the in-Minikube container (the same container ID `script/mutagen.sh` discovers), or the Kubernetes / Remote extensions. The primary entry point is the CLI's `shell`.

## Troubleshooting

- `collab-devcontainer doctor` first — it checks context, services, image, sync, and paths.
- **Wrong context:** the CLI refuses to act unless your current context is `minikube` (so it can never touch a prod cluster). `kubectl config use-context minikube`.
- **`shell` keeps recreating the pod:** it should only ever do that once, and only when a rebind will actually help. If you see it more than once, run `collab-devcontainer mounts` — a 9p export that reads `EIO` at the *node* can't be fixed by recreating the pod, and the CLI will now say so and stop rather than restart in a loop. If a remount doesn't clear it, `minikube stop && minikube start`.
- **Sync dangles after `restart`:** a recreated pod is a new container, so the old Mutagen sync points at a dead ID. `restart` re-creates it automatically; if you recreate the pod by hand, re-run `script/mutagen.sh`.
- **Port `:5173`/`:3001` already bound:** you can't run `npm run dev` in both this pod and a second app-dev at the same host port. Stop one (`pkill -f 'port-forward.*app-dev'`).
- **PVC won't bind:** your cluster may lack a default StorageClass — set `storageClassName` in `k8s/claude-pvc.yaml` (e.g. `standard-rwo`).
- **Image changes not picked up:** `collab-devcontainer rebuild` (image) — `up` won't rebuild an image that already exists.

# Scripts

Helper scripts for local development and release builds.

## `build.sh` — Release build

Builds both frontends (`web`, `web-cluster`) into the server's static
directories, then compiles the Go server binary into `dist/`.

```bash
# Build for all release platforms (default)
./scripts/build.sh

# Build only for the current machine's platform (faster, for local dev)
./scripts/build.sh --local
```

### All-platform vs local

| Mode              | Command                   | Platforms built                                          | When to use                                  |
| ----------------- | ------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| All platforms     | `./scripts/build.sh`      | `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64` | Producing release artifacts                  |
| Local only        | `./scripts/build.sh --local` | `$(go env GOOS)/$(go env GOARCH)`                     | Fast local builds / testing a single binary  |

`--local` cross-compiles nothing — it targets only the platform Go reports for
the current machine, which skips the other three builds. Use it when you just
need a runnable binary for the machine you are on; use the default when you need
the full set of release binaries.

### Environment variables

| Variable     | Default | Description                                  |
| ------------ | ------- | -------------------------------------------- |
| `VERSION`    | `dev`   | Version stamped into the binary (leading `v` is stripped). |
| `OUTPUT_DIR` | `dist`  | Directory the binaries are written to.       |

## `dev.sh` — Development server

Runs the backend and frontend together with hot reload. Pass `--cluster` to run
the cluster-mode stack instead of the normal one.

```bash
./scripts/dev.sh            # normal mode
./scripts/dev.sh --cluster  # cluster mode
```

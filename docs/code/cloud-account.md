# Cloud Account Linking

A user signed in to the cloud can see every Pockode instance on every machine they have linked — servers, clusters and the nodes a cluster starts — and open them from one list. Pockode's side of that is three things: a machine credential (`cloud.json`), the `pockode login` / `pockode logout` commands that create and remove it, and the relay attaching each running process to the account the credential names.

Linking is purely additive. A machine that never ran `pockode login` is a **guest**, and a guest's relay requests are byte-for-byte what they were before accounts existed. A link that goes bad — revoked, unlinked on the web, refused — never stops the relay from working; the worst it does is leave the instance off the list.

This document is the interoperability contract as Pockode implements it. The cloud's account design document is the other half.

## The Machine Credential: `cloud.json`

```json
{ "cloud_url": "https://cloud.pockode.com", "machine_token": "<64 hex>" }
```

It lives at `os.UserConfigDir()/pockode/cloud.json` — `~/.config/pockode/` on Linux, `~/Library/Application Support/pockode/` on macOS, `%AppData%\pockode\` on Windows — not in a data directory. Every Pockode process the OS user runs (servers in different projects, a cluster, the nodes it starts) reads the same file, so they are all listed under the same machine. One OS user on one machine is one machine in the account.

- **The token is used only by the cloud that issued it.** A process uses the token only when `cloud_url` equals its own `-cloud-url`, compared as an exact string; otherwise it behaves as if there were no file. A process pointed at another cloud — a self-hosted one, a development one — must not hand its operator a credential for this machine's account elsewhere. `cloudcred.Store.MachineToken` is the one place that rule lives.
- **It is protected like `relay.json`.** The directory is restricted to the owner and the file written atomically with mode `0600`, for the reason given in [Relay → Token Protection](relay-system.md#token-protection): on Windows only the directory's ACL protects anything.
- **A damaged file means "not linked".** It is quarantined as `cloud.json.corrupt`, as `relay.json` is, and the processes carry on as guests.

## `pockode login`

```
pockode login [-cloud-url https://cloud.pockode.com]
```

Linking is the OAuth device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): the terminal shows a link, the user approves it in a browser where they are signed in to the cloud, and the command polls until the approval turns into a machine token.

1. **An existing link is checked first.** If `cloud.json` names this cloud, `GET /api/machine` with `Authorization: Bearer <machine_token>`: 200 (`{email, name}`) means the machine is already linked — the command says to whom and exits, pointing at `pockode logout` for switching accounts; 401 means the link is no longer valid and the flow below runs; anything else is an error. A `cloud.json` naming another cloud is never shown to this one: the command says it is relinking and runs the flow.
2. **Authorize.** `POST /api/device/authorize` with `{hostname, os_user, os}` (`os.Hostname()`, the current user name, `runtime.GOOS`). The cloud names the machine `os_user@hostname`. The answer carries `device_code`, `user_code`, `verification_uri_complete`, `interval` and `expires_in`.
3. **Show the link.** `verification_uri_complete` is printed and drawn as a QR code, with the user code split as `BCDF-GHJK` so the user can check it against the page before approving.
4. **Poll.** `POST /api/device/token` with `{device_code}`, waiting `interval` seconds (5 when the cloud names none) before each request:

   | Answer | What happens |
   |---|---|
   | 400 `authorization_pending` | Keep polling |
   | 400 `slow_down` | Add 5 s to the interval, keep polling |
   | 400 `expired_token` | Stop: the code expired, run `pockode login` again |
   | 400 `access_denied` | Stop: declined in the browser |
   | 200 `{machine_token}` | Save it with `cloud_url` = this `-cloud-url` |
   | No answer, or 5xx | Keep polling until the code expires; the outage is reported once, not on every poll |
   | Anything else | Stop with the error — including a 200 that cannot be read, since the cloud hands a token out only once and polling again would only report it expired |

   The command also gives up on its own once `expires_in` has passed.

`cloud.json` is written only at the end, atomically, so Ctrl+C at any point leaves the previous state intact. Running processes notice the new file within 5 seconds ([below](#following-login-and-logout)); none needs a restart.

## `pockode logout`

```
pockode logout
```

Revokes the token with `POST /api/machine/revoke` (`Authorization: Bearer <machine_token>`) at the `cloud_url` in `cloud.json` — the cloud that issued it, which is why the command takes no `-cloud-url` — and then deletes the file.

- **The file goes whatever the cloud answers.** The user asked for this machine to stop acting for the account, and that much is in local hands. A 401 means the cloud already forgot the token, so the machine is unlinked on both sides. Any other failure — offline, the cloud unreachable — is reported with a request to unlink the machine on the cloud's web page, where a link left behind can be removed.
- Without a `cloud.json` it only says the machine is not linked.

Switching accounts is `pockode logout`, then `pockode login`.

## Attaching the Relay

Register and refresh ([Relay → Startup Flow](relay-system.md#startup-flow)) carry two more fields when the process has a token for its cloud:

| Request field | Value |
|---|---|
| `machine_token` | The token from `cloud.json` |
| `instance` | `{ "kind": "server" \| "cluster" \| "node", "name": string, "path": string }` |

A guest sends neither, and its body is exactly the pre-account one (`TestClientRequestBodies` pins all four shapes). Both fields go in the JSON body only, never in a URL.

The answer carries at most one of two fields:

| Response field | Meaning | Banner |
|---|---|---|
| `account_email` | The relay is attached to this account | `▸ Cloud  <email>` |
| `account_error` | The token was not accepted (`"invalid_machine_token"` today; any value means the same) | `⚠ This machine is no longer linked to your cloud account` / `Run pockode login to link it again` |
| neither | Guest | Unchanged |

A rejected token does not fail the request: the status, subdomain and URL are what they would have been for a guest. The email is shown and nothing else — it is not logged, and not written to `relay.json`.

### What an Instance Reports

| Process | `kind` | `name` / `path` |
|---|---|---|
| `pockode` | `server` | The working directory (`-work`): its basename and absolute path |
| `pockode cluster` | `cluster` | The **data directory** (`-data`, default `~/.pockode-cluster`), made absolute |
| A node a cluster started | `node` | Its working directory, as for `server` |

- **A cluster reports its data directory** because it has no working directory of its own: the directory it was started from is arbitrary, while the data directory is what tells one cluster from another on the same machine.
- **A node knows it is one** from `POCKODE_CLUSTER_NODE`, which the cluster sets in `nodeEnv` (dropping any inherited value). The node reads and **unsets** it at startup, before spawning anything, so the AI CLIs, terminals or nested `pockode` it starts do not inherit the claim. `cluster/node.MarkerEnvVar` and `TakeMarker` hold both halves.
- `path` is shown to the account owner only; it exists to tell apart projects of the same name.
- The [privacy policy](../../site/content/privacy.md) tells users what `pockode login` and a linked instance send; a change to either must update it in the same change.

### A Refused Attachment Falls Back to Guest

The cloud may refuse a body that carries an attachment: 400 for an instance field it will not take (the cloud bounds the fields — a path containing a control character, for one), or 413 from a cloud that predates accounts and caps the whole body at 4 KiB, which a long path can exceed. Either way `Manager.call` sends the same request again as a guest, and the relay comes up unattached with a warning in the log. The link must never be what keeps the relay from working.

An unreadable `cloud.json` likewise means guest, with the warning logged once rather than on every check.

### Following Login and Logout

`Manager` starts a watcher next to the reconnect loop, shared by server and cluster mode. Every 5 seconds — the delay the cloud's account design promises — it re-reads `cloud.json` and compares the effective token (the one for this cloud, or none) with the one the account state was last settled for. When they differ it **refreshes**, never re-registers, so the subdomain and the remote URL stay where they are: `pockode login` attaches running processes, `pockode logout` turns them back into guests.

- Every register and refresh reads `cloud.json` afresh, so the reconnect loop's renewals also carry the current link.
- `cloudCallsMu` serializes the watcher with the reconnect loop, since both rewrite `relay.json`.
- A failed refresh is retried on the next poll, which still sees the difference; a run of failures is logged once, not on every poll. The exception is a 401 for the relay token: asking again cannot fix that, and the reconnect loop registers anew once its uplink is rejected too, reading `cloud.json` as it does. The watcher logs it once and leaves it there.
- The watcher stops for good when the cloud requires a newer client, as the reconnect loop does.
- A machine unlinked on the web keeps working unattached until its next refresh — a restart, a renewal, or a change to `cloud.json` — which then reports `account_error`.

## Code Paths

| Component | Path | Responsibility |
|---|---|---|
| Credential store | `server/cloudcred/` | `cloud.json`: load, save, delete, and the `cloud_url` match |
| Login / logout | `server/cloudlogin/` | Device flow, existing-link check, revoke |
| Attachment | `server/relay/account.go` | `Instance`, `Attachment`, `Account` |
| Manager | `server/relay/relay.go` | Attaching on register/refresh, guest fallback, the 5 s watcher |
| Node marker | `server/cluster/node/process.go` | `POCKODE_CLUSTER_NODE`: `nodeEnv` sets it, `TakeMarker` reads and unsets it |
| Banner | `server/startup/banner.go` | The account line, and the QR code login reuses |

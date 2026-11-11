# Cloud Account Linking

A user signed in to the cloud can see every Pockode instance on every machine they have linked — servers, clusters and the nodes a cluster starts — and open them from one list. Pockode's side of that is three things: a machine credential (`cloud.json`); the device flow that creates it and the revoke that removes it, run either by `pockode login` / `pockode logout` in a terminal or by a running process on its UI's behalf ([below](#linking-from-the-ui)); and the relay attaching each running process to the account the credential names.

Linking is purely additive. A machine that was never linked is a **guest**, and a guest's relay requests are byte-for-byte what they were before accounts existed. Neither a link that goes bad — revoked, unlinked on the web, or removed along with a deleted account — nor an instance the cloud will not list ever stops the relay from working; the worst it does is leave the instance off the list.

This document is the interoperability contract as Pockode implements it. The cloud's account design document is the other half.

## The Machine Credential: `cloud.json`

```json
{ "cloud_url": "https://cloud.pockode.com", "machine_token": "<64 hex>" }
```

It lives at `os.UserConfigDir()/pockode/cloud.json` — `~/.config/pockode/` on Linux, `~/Library/Application Support/pockode/` on macOS, `%AppData%\pockode\` on Windows — not in a data directory. Every Pockode process the OS user runs (servers in different projects, a cluster, the nodes it starts) reads the same file, so they are all listed under the same machine. One OS user on one machine is one machine in the account.

- **The token is used only by the cloud that issued it.** A process uses the token only when `cloud_url` equals its own `-cloud-url`, compared as an exact string; otherwise it behaves as if there were no file. A process pointed at another cloud — a self-hosted one, a development one — must not hand its operator a credential for this machine's account elsewhere. `cloudcred.Credential.TokenFor` is the one place that rule lives; the relay, the existing-link check and the UI's status all go through it.
- **It is protected like `relay.json`.** The directory is restricted to the owner and the file written atomically with mode `0600`, for the reason given in [Relay → Token Protection](relay-system.md#token-protection): on Windows only the directory's ACL protects anything.
- **A damaged file means "not linked".** It is quarantined as `cloud.json.corrupt`, as `relay.json` is, and the processes carry on as guests.

## Linking: The Device Flow

Linking is the OAuth device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): Pockode shows a link, the user approves it in a browser where they are signed in to the cloud, and Pockode polls until the approval turns into a machine token. The steps are one implementation (`server/cloudlogin/flow.go`) with two front ends — [`pockode login`](#pockode-login) and a [running process](#linking-from-the-ui) — which differ only in what they tell the user and in what they do with the token at the end.

1. **An existing link is checked first.** If `cloud.json` names this cloud, `GET /api/machine` with `Authorization: Bearer <machine_token>`: 200 (`{email, name}`) means the machine is already linked — the flow ends there, reporting to whom; 401 means the link is no longer valid and the flow below runs; anything else is an error. A `cloud.json` naming another cloud is never shown to this one: the flow runs and replaces it.
2. **Authorize.** `POST /api/device/authorize` with `{hostname, os_user, os}` (`os.Hostname()`, the current user name, `runtime.GOOS`). The cloud names the machine `os_user@hostname`. The answer carries `device_code`, `user_code`, `verification_uri_complete`, `interval` and `expires_in`.
3. **Show the link.** `verification_uri_complete` and the user code, so the user can check the code against the page before approving.
4. **Poll.** `POST /api/device/token` with `{device_code}`, waiting `interval` seconds (5 when the cloud names none) before each request:

   | Answer | What happens |
   |---|---|
   | 400 `authorization_pending` | Keep polling |
   | 400 `slow_down` | Add 5 s to the interval, keep polling |
   | 400 `expired_token` | Stop: the code expired |
   | 400 `access_denied` | Stop: declined in the browser |
   | 200 `{machine_token}` | Save it with `cloud_url` = this `-cloud-url` |
   | No answer, or 5xx | Keep polling until the code expires; the outage is reported once, not on every poll |
   | Anything else | Stop with the error — including a 200 that cannot be read, since the cloud hands a token out only once and polling again would only report it expired |

   Pockode also gives up on its own once `expires_in` has passed.

`cloud.json` is written only at the end, atomically, so stopping the flow at any point leaves the previous state intact. Running processes notice the new file within 5 seconds ([below](#following-login-and-logout)); none needs a restart.

### `pockode login`

```
pockode login [-cloud-url https://cloud.pockode.com]
```

The terminal front end. It prints the link and draws it as a QR code, with the user code split as `BCDF-GHJK`; it reports a cloud outage once rather than on every poll; and Ctrl+C is how the flow is stopped. Already linked, it says to whom and points at `pockode logout` for switching accounts. It saves the token unconditionally, overwriting whatever `cloud.json` holds by then.

## Unlinking

Unlinking revokes the token with `POST /api/machine/revoke` (`Authorization: Bearer <machine_token>`) at the `cloud_url` in `cloud.json` — the cloud that issued it, which may be another than the process's own, and is why unlinking takes no cloud URL — and then deletes the file. `pockode logout` and the UI's [`cloud_link.unlink`](#the-cloud_link-rpc) share the implementation.

- **The file goes whatever the cloud answers.** The user asked for this machine to stop acting for the account, and that much is in local hands. A 401 means the cloud already forgot the token, so the machine is unlinked on both sides. Any other failure — offline, the cloud unreachable — is reported with a request to unlink the machine on the cloud's web page, where a link left behind can be removed.
- Without a `cloud.json` there is nothing to do, and the user is told the machine is not linked.

```
pockode logout
```

Switching accounts is unlinking, then linking again.

## Linking from the UI

A running server, node or cluster can run the device flow itself, so the user links the machine from Pockode's UI instead of a terminal. The UI only watches: it shows the user code and the link, and on a phone the user opens the link in a browser that is usually already signed in to the cloud, so approving is one tap. Nothing changes on the cloud's side — it is the same device flow, the same `cloud.json`, and the same revoke. `cloudlogin.Service` is the process's half; [`cloud_link.*`](#the-cloud_link-rpc) is what the UI sees of it. What the user sees — Settings → Cloud and its link sheet — is [cloud-link-ui.md](../cloud-link-ui.md).

Because `cloud.json` belongs to the OS user, linking from any one process links the machine for all of them: every server, every node of a cluster and the cluster itself. Each process still runs its flow against its own `-cloud-url`.

### One Flow, Owned by the Process

- **At most one flow per process.** Starting while one runs returns the running flow, so two screens that both read "not linked" and both press start land in the same flow.
- **The flow is the process's, not the client's.** It carries on through a reload or a dropped connection, and a client that comes back finds it in the status. Nothing a client does ends it but an explicit cancel; it does not survive a restart.
- **Expiry is the process's.** The flow ends when `expires_in` has passed and tells the client when that is (`expires_at`); a client never times a flow out itself. A cloud that names no `expires_in` gets 10 minutes — the cloud's own value — so a flow nobody finishes cannot hold the process's one slot forever. (The CLI has no such fallback: Ctrl+C ends it.)
- **Once approved, a flow can no longer be cancelled.** The cloud hands a machine token out only once, so from the moment the flow holds one it must end with the token saved or revoked. It moves to `finishing`, drops the code and the link, and a cancel then just returns it as it is. Closing the process waits for it too.
- **A link written meanwhile is kept.** Between the start and the approval, another process or `pockode login` may have linked the machine. Overwriting that token would leave its machine in the account with nothing acting for it, so the flow saves only over the token it started from (`cloudcred.Store.SaveIfUnchanged`, a check and a write under the file's lock that `Store.Save` and the relay's reads also take). If another token for this cloud appeared, the flow asks the cloud about it: valid → keep it, revoke the flow's own and end `already_linked`; 401 → save over it; no answer → keep it, revoke the flow's own and fail, since a link that cannot be checked may still be valid. When that revoke fails too the flow says so (`left_behind`): its machine stays in the account until the user removes it on the web.
- **Unlink waits for a flow that is saving.** An unlink that read `cloud.json` just before a flow saved, and deleted it just after, would remove a token without ever revoking it; the two take turns.
- **The result shows at once.** After saving, and after an unlink, the process's own relay re-reads `cloud.json` immediately (`relay.Manager.CheckCloudCredentials`) instead of at its next 5-second poll. Other processes keep relying on their poll.
- **Secrets stay in the process.** The device code and the machine token appear in no reply, notification or log. The user code and the link are not logged either, and are cleared when the flow leaves `waiting`: whoever has them can approve the flow into their own account. No client ever names a cloud: a flow links to the process's `-cloud-url`, and an unlink revokes at the cloud `cloud.json` names.

### The Status

What a client shows is one value, read entirely locally:

| Field | Values |
|---|---|
| `cloud_url` | The process's `-cloud-url`, the cloud a flow links to |
| `credential` | `none`, `linked` (a token from this cloud), `other_cloud` (a token this process never uses; linking replaces it, unlinking revokes it there) |
| `other_cloud_url` | With `other_cloud`: the cloud that issued the stored token, where an unlink would revoke it |
| `machine_name` | `os_user@hostname`, as a flow would identify this machine to the cloud now; absent when it cannot be worked out. The cloud lists the name it was given at linking, so after a hostname change the two can differ |
| `relay` | `disabled`; `pending` — the relay has not yet presented `cloud.json` as it is now; `guest`; `attached` (with `email`); `link_invalid` — linking again fixes it; `not_attached` — it does not ([why](#why-an-instance-is-not-attached)) |
| `flow` | The running flow, or the last one to end, so a client that was away still learns how it ended; absent when there has been none since the process started |

A flow carries `id`, `phase` and `started_at`, plus what its phase needs:

| `phase` | Meaning and fields |
|---|---|
| `starting` | The existing link is being checked and a code requested |
| `waiting` | `user_code`, `verification_url`, `expires_at`; `cloud_unreachable` while polling gets no answer (the flow carries on) |
| `finishing` | Approved; saving the token, or revoking it ([above](#one-flow-owned-by-the-process)) |
| `linked` | `email` and `machine_name`, when the cloud could be asked |
| `already_linked` | A valid link was there at the start or appeared meanwhile, and was left alone: `email`, `machine_name`, `left_behind` |
| `failed` | `failure.reason`: `expired`, `declined` or `other` (with `detail`); `left_behind` |
| `canceled` | |

`revision` grows with every change to any flow, from one counter per process, so any two copies from the same process compare — of one flow or of two, a newer flow's always being above an older one's. A reply and a notification travel separately and can arrive in either order, so a client keeps whichever copy has the higher revision. Revisions restart with the process: a client that subscribes again (after a reconnect) takes the new snapshot's flow as it is.

`relay: pending` lets the UI tell "just linked, the relay is catching up" from a real guest. It reads that from `relay.Manager.AccountFor`, which reports whether the relay's last account result was for the token `cloud.json` holds now.

### The `cloud_link` RPC

The main server, a node and a cluster all serve it (`ws.CloudLink`), each for its own process; every method needs the usual `auth` first.

| Method | Params | Result |
|---|---|---|
| `cloud_link.subscribe` | `{id}` | `{status}` |
| `cloud_link.unsubscribe` | `{id}` | `{}` |
| `cloud_link.start` | — | `{flow}`: the new flow, or the one already running |
| `cloud_link.cancel` | `{flow_id}` | `{flow}` as it is afterwards |
| `cloud_link.unlink` | — | `{unlinked: {was_linked, cloud_url?, revoke_error?}}` |
| `cloud_link.changed` (notification) | — | `{id, status}` |

- **There is no status method.** The status is the subscribe reply, and `cloud_link.changed` carries the whole status again on every change, never a delta — the same pattern as [`remote_url.subscribe`](websocket-rpc.md#following-the-remote-url), including the notification that follows the reply. Changes are a flow's progress, a link or unlink made here, and the relay's account result changing (`relay.Config.OnAccountChange`), which is also how a link or unlink of this cloud's token made by another process or by the CLI reaches the UI.
- **`cloud_link.unlink` can be slow**: up to the cloud client's 30-second timeout, and as long again while an approved flow is saving. A client gives it a longer timeout than its default.
- **Errors.** `cancel` without a `flow_id`, or with one that is not the latest flow, is invalid params, as is a missing or reused subscription `id`. A process that cannot keep a cloud credential at all — the OS user has no configuration directory — answers every `cloud_link.*` request with `CodeCloudLinkUnavailable` (`-32013`); nothing short of a restart changes that, so the client shows linking as unavailable rather than retrying. Anything else (an unreadable `cloud.json`, a failed delete, a process shutting down) is an internal error carrying the reason.

### Known Limits

- **`pockode login` has no such guard** ([above](#pockode-login)): a CLI login that finishes after a UI flow has linked replaces that token without revoking it.
- **Unlinking in another process is not serialized with a flow's save.** Unlink reads `cloud.json`, revokes, then deletes; the turn-taking with a saving flow holds only within one process. A `pockode logout`, or another process's `cloud_link.unlink`, that reads the old token just before a flow here saves its new one deletes that new token without revoking it, and the flow still reports `linked`.
- **Only a link to this cloud is protected.** A token from another cloud written while a flow runs is replaced, as a `pockode login` here would.
- **Only this cloud's token is watched, and only by the relay.** With the relay disabled, a link or unlink made by another process shows only once the status is read again — for a later notification or a new subscribe. With it enabled, the same holds for a change that leaves this cloud's token as it was: a token from another cloud written or removed (`credential` moving between `none` and `other_cloud`), or a damaged file quarantined while no token for this cloud was in it.
- **Some relay states can look stale.** After the relay's own token is rejected, `relay` stays `pending` until the reconnect loop registers again; after the cloud requires a newer client nothing settles any more; and the [413 guest fallback](#only-an-oversized-body-falls-back-to-guest) shows as `credential: linked` with `relay: guest` and no reason.

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
| `account_error` | The relay was not attached; the value says why ([below](#why-an-instance-is-not-attached)) | Depends on the value |
| neither | Guest | Unchanged |

Nothing about the account fields fails the request — short of making the body too large ([below](#only-an-oversized-body-falls-back-to-guest)): the status, subdomain and URL are what they would have been for a guest. The email is shown and nothing else — it is not logged, and not written to `relay.json`.

### Why an Instance Is Not Attached

| `account_error` | Cause | Banner |
|---|---|---|
| `invalid_machine_token` | The token is malformed or names no machine — never issued, or unlinked on the web, revoked, or removed with a deleted account since | `⚠ This machine is no longer linked to your cloud account` / `Run pockode login to link it again` |
| `invalid_instance` | The cloud will not list the instance: `kind` must be one of the three, `name` and `path` non-empty and free of control characters, `name` at most 255 bytes and `path` at most 4096. Linking again cannot fix it — it is a directory name with a control character or a path over the limit, or else a Pockode bug | `⚠ This instance could not be linked to your cloud account` |
| `internal_error` | The cloud failed while attaching. Pockode does not retry on its own; the next refresh (a restart, a renewal, a change to `cloud.json`) attaches again | As for `invalid_instance` |
| Any other value | Taken as `internal_error`, so the cloud can add values | As for `invalid_instance` |

- **`account_error` is read through `Account.LinkInvalid` and `Account.NotAttached`**, never compared value by value, so an unknown value cannot slip past both banner lines.
- **The cloud checks the instance before it looks the token up**, so a request wrong on both counts reports `invalid_instance`; once the instance is fixed, the next refresh can still report `invalid_machine_token`.
- **The log carries the reason.** The banner line is all the terminal shows; the warning in the log names the `account_error` value, and the instance when linking again will not help.

### What an Instance Reports

| Process | `kind` | `name` / `path` |
|---|---|---|
| `pockode` | `server` | The working directory (`-work`): its basename and absolute path |
| `pockode cluster` | `cluster` | The **data directory** (`-data`, default `~/.pockode-cluster`), made absolute |
| A node a cluster started | `node` | Its working directory, as for `server` |

- **A cluster reports its data directory** because it has no working directory of its own: the directory it was started from is arbitrary, while the data directory is what tells one cluster from another on the same machine.
- **A node knows it is one** from `POCKODE_CLUSTER_NODE`, which the cluster sets in `nodeEnv` (dropping any inherited value). The node reads and **unsets** it at startup, before spawning anything, so the AI CLIs, terminals or nested `pockode` it starts do not inherit the claim. A node that [restarts itself](self-restart.md) puts it back (`RestoreMarker`) once its shutdown is done and nothing more will be spawned, right before the restart, so its successor comes back as the same node rather than as a `server`. `cluster/node.MarkerEnvVar`, `TakeMarker` and `RestoreMarker` hold all three.
- `path` is shown to the account owner only; it exists to tell apart projects of the same name.
- The [privacy policy](../../site/content/privacy.md) tells users what linking a machine and a linked instance send; a change to either must update it in the same change.

### Only an Oversized Body Falls Back to Guest

Since the account fields never fail a request, Pockode never sends one again without them. The exception is the cloud's body size cap, answered with 413, which the attachment alone can push a body over: a cloud that predates accounts caps the body at 4 KiB, which a long path can exceed; one that has accounts caps it at 8 KiB, which a path full of characters JSON escapes (Go writes `&` as `\u0026`) can still exceed. `Manager.call` then sends the same request again as a guest, and the relay comes up unattached with a warning in the log. The link must never be what keeps the relay from working.

Any other failure, 400 included, fails the call as it would for a guest.

An unreadable `cloud.json` likewise means guest, with the warning logged once rather than on every check.

### Following Login and Logout

`Manager` starts a watcher next to the reconnect loop, shared by server and cluster mode. Every 5 seconds — the delay the cloud's account design promises — it re-reads `cloud.json` and compares the effective token (the one for this cloud, or none) with the one it last presented to the cloud; a process that has just linked or unlinked from the UI has it re-read at once (`CheckCloudCredentials`). When they differ it **refreshes**, never re-registers, so the subdomain and the remote URL stay where they are: linking attaches running processes, unlinking turns them back into guests. Whenever the account result, or the token it was settled for, changes, `Config.OnAccountChange` tells the process's [link service](#linking-from-the-ui); it is called synchronously, also from `Start`, so it is wired before `Start` and must not block.

- Every register and refresh reads `cloud.json` afresh, so the reconnect loop's renewals also carry the current link.
- `cloudCallsMu` serializes the watcher with the reconnect loop, since both rewrite `relay.json`.
- A failed refresh is retried on the next poll, which still sees the difference; a run of failures is logged once, not on every poll. The exception is a 401 for the relay token: asking again cannot fix that, and the reconnect loop registers anew once its uplink is rejected too, reading `cloud.json` as it does. The watcher logs it once and leaves it there.
- The watcher stops for good when the cloud requires a newer client, as the reconnect loop does.
- A machine unlinked on the web, or removed because its account was deleted, keeps working unattached until its next refresh — a restart, a renewal, or a change to `cloud.json` — which then reports `account_error: invalid_machine_token`. The cloud keeps its relays, so the subdomain and the remote URL stay the same.

## Code Paths

| Component | Path | Responsibility |
|---|---|---|
| Credential store | `server/cloudcred/` | `cloud.json`: load, save (`SaveIfUnchanged` for a flow that must not overwrite a link written meanwhile), delete, and the `cloud_url` match (`Credential.TokenFor`) |
| Device flow | `server/cloudlogin/flow.go` | The steps both front ends share: existing-link check, authorize, poll, unlink |
| Login / logout | `server/cloudlogin/cloudlogin.go` | `Linker`: the terminal front end |
| Link service | `server/cloudlogin/service.go` | `Service`: the process's one flow, its status, unlink, and the guard against overwriting a link written meanwhile |
| RPC | `server/ws/rpc_cloud_link.go`, `server/watch/cloud_link.go` | `cloud_link.*` for server, node and cluster; `CloudLinkWatcher` pushes `cloud_link.changed` |
| Attachment | `server/relay/account.go` | `Instance`, `Attachment`, `Account` and the reading of `account_error` |
| Manager | `server/relay/relay.go` | Attaching on register/refresh, the 413 guest fallback, the 5 s watcher; `AccountFor`, `OnAccountChange` and `CheckCloudCredentials` for the link service |
| Node marker | `server/cluster/node/process.go` | `POCKODE_CLUSTER_NODE`: `nodeEnv` sets it, `TakeMarker` reads and unsets it, `RestoreMarker` puts it back for a restart |
| Banner | `server/startup/banner.go` | The account line, and the QR code `pockode login` reuses |

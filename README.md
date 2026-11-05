# dsh-session-mailbox

A file-based mailbox plus push notification between [DSH](https://github.com/deepseek-ai/deepseek-harness) sessions. Works in **any workspace** — no project-specific path is hard-coded.

## Tools

All tool names are prefixed `mailbox_*` to avoid ever shadowing a platform tool.

| Tool | Behavior |
|---|---|
| `mailbox_send` | Drops a timestamped `.md` file into the current workspace mailbox. Optional `notifier: true` also pushes a notification into the target session. |
| `mailbox_read` | Reads pending messages and moves them into `_read/`. |
| `mailbox_sessions` | Lists live sessions (id, title, folder, created at, agent status). |
| `mailbox_notify` | Pushes a message into another live session and wakes it up. |

## Install

Author the bundle, then install it in the current profile with `plugin_manager`:

```text
plugin_manager install_bundle <absolute/path/to/this/directory>
```

or declare it in the profile and link it:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-session-mailbox": "link:/path/to/dsh-session-mailbox" },
  "dsh": { "profile": { "bundles": [ "dsh-session-mailbox" ] } }
}
```

Replacing the JavaScript of an already-installed package requires a DSH restart to load a fresh module generation.

## How the mailbox is resolved

The mailbox root is resolved on **every call** from the workspace of the session that runs the tool:

```js
const ws = ctx.agents.currentInitiator()?.session.header.cwd
```

- no `config.folder` → `_dsh-mailbox` at the root of the current workspace;
- relative `config.folder` → resolved against the current workspace;
- absolute `config.folder` → explicit override (rarely needed).

> `process.cwd()` of the host process **is the profile directory**, not the session
> workspace — it is only a last-resort fallback.

Two sessions in the same workspace share one mailbox; sessions in different
workspaces never interfere.

## Origin metadata

A notified message carries its originating session:

```js
source: { kind: 'agent-message', form: 'relay', senderSessionId: '<id>' }
```

- The chat UI renders this source as a collapsible "trigger" node (agent icon,
  "From session {id}") — no client plugin needed.
- The model-facing content is prefixed with `Message received from session {id}: `.
- The sender is read via `ctx.agents.currentInitiator()?.id`.

## Contracts

- `ctx.sessions.list()` → `Session[]` (a method; there is no `.getSnapshot()`).
- `ctx.agents.get(id)` → live `Agent`; `agent.followup(msg)` → push + wake.
- `ctx.agents.currentInitiator()` → the calling `Agent` (the sender session).
- `UserMessage = { role:'user', content:[{type:'text',text}], source:{...}, id:uuid }`.

## Configuration

`cordis.patch.yml` mounts the bundle with `config: {}` by default. To override
the mailbox folder globally:

```yaml
- insert:
    - id: session-mailbox
      name: 'dsh-session-mailbox'
      config:
        folder: '_shared-inbox'   # relative to each session's workspace
```

## License

[MIT](LICENSE)

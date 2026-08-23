# OpenCode Session Archiver

TUI plugin for OpenCode `1.18.21+` that replaces the current root session with a compact continuation, then deletes the original only after explicit confirmation.

## Install

```bash
opencode plugin @evgenyzh/opencode-session-archiver --global
```

Restart OpenCode after installing. The plugin is registered in the TUI configuration, so it is loaded at startup.

For local development, add the source module to `~/.config/opencode/tui.json`:

```json
{
  "plugin": [["/absolute/path/to/opencode-session-archiver/src/tui.tsx"]]
}
```

## Use

Run `/archive-session`, enter an optional replacement title, and review the deletion confirmation.

The command:

1. Refuses a child session or an active source/descendant.
2. Runs OpenCode's normal compaction on the original.
3. Creates a new root session containing the native summary plus a bounded recent tail.
4. Switches to and verifies the new session.
5. Deletes the original and its descendants only after confirmation.
6. Re-reads every expected deleted ID and reports an error if OpenCode leaves any survivor.

If a failure occurs before deletion, the original session is kept. Cancelling the final confirmation keeps both sessions.

## Limits

The imported tail defaults to 64,000 characters total and 8,000 characters per completed tool output. It keeps the most recent material, including user/assistant text, tool inputs and outputs, subtask metadata, files, and patch file lists. It intentionally omits reasoning, snapshots, and file data URLs.

OpenCode's SDK does not expose a way to import a native compaction pair. The replacement therefore stores the extracted native summary and tail in one synthetic, model-visible user message without making a second model call.

The plugin never uses SQLite directly and does not run `VACUUM`; OpenCode itself retains SQLite free pages after deletion.

## Development

```bash
npm install
npm run check
```

## License

MIT

export function codexRestartError(code: string) {
  const messages: Record<string, string> = {
    session_changed_refresh: 'This session changed. Refresh sessions before restarting it.',
    codex_restart_busy: 'Another Codex restart is in progress. Wait for it to finish.',
    codex_history_unavailable: 'Cannot identify one saved Codex conversation. Nothing was restarted. A new chat must have saved history first; use the CLI to resume older, unlinked chats.',
    codex_not_directly_managed: 'This pane is not a directly managed Codex CLI. Use its terminal to exit and resume it manually.',
    codex_requires_single_pane: 'Restart & resume supports a session with one pane only. Other panes were left untouched.',
    codex_target_ambiguous: 'More than one main Codex conversation was found. No conversation was guessed; use the CLI manually.',
    codex_target_changed: 'The Codex process or conversation changed. Refresh before trying again; no replacement was forced.',
    codex_directory_changed: 'Codex is using a different saved directory. Resume it manually to choose the correct directory.',
    codex_exit_timeout: 'Codex did not finish exiting in time. No second CLI was started. Refresh to check its state.',
    codex_restart_uncertain: 'Restart could not be confirmed. Refresh and check the terminal before retrying; input was not replayed.',
    codex_inspection_limit: 'Codex identity inspection reached its safety limit. Use the CLI manually; no history was guessed.',
    codex_safe_exit_unavailable: 'This host cannot safely monitor Codex exit. Use the terminal to exit and resume manually.',
    codex_inspection_unavailable: 'Cannot safely inspect this Codex process. Refresh to check its state; no forced replacement was made.',
    restart_request_timeout: 'The restart response timed out. It may have completed: refresh sessions before doing anything else.',
  };
  return messages[code] || code;
}

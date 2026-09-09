// Only new, explicitly instrumented Codex panes opt in. Normalize inside tmux:
// inventory never transfers arbitrary pane titles (which can contain private text).
export const ACTIVITY_OPTION = '@pocketterminal_activity';
export const ACTIVITY_VERSION = 'codex-title-v1';
export type Activity = 'working' | 'awaiting_input' | 'ready' | 'unknown' | 'unavailable';
const eligible = `#{&&:#{&&:#{==:#{${ACTIVITY_OPTION}},${ACTIVITY_VERSION}},#{==:#{pane_current_command},codex}},#{&&:#{pane_active},#{window_active}}}`;
export const ACTIVITY_FORMAT = `#{?${eligible},#{?#{==:#{pane_title},Ready},ready,#{?#{m/r:^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (Working|Thinking)$,#{pane_title}},working,#{?#{||:#{==:#{pane_title},[ ! ] Action Required},#{==:#{pane_title},[ . ] Action Required}},awaiting_input,unknown}}},unavailable}`;
export function activity(value: string | undefined): Activity {
  return value === 'working' || value === 'awaiting_input' || value === 'ready' || value === 'unknown' ? value : 'unavailable';
}

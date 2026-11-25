/** Shared presentation emoji for built-in tools on the app and Telegram. */
export function toolIcon(name: string): string {
  if (name.startsWith("subagent_")) return "🤖";
  if (name.startsWith("task_")) return "🗓️";
  switch (name) {
    case "read": return "📖";
    case "write": return "📄";
    case "edit": return "📝";
    case "bash": return "💻";
    case "web_search":
    case "tool_search": return "🔍";
    case "web_extract": return "🌐";
    case "send_attachment": return "📎";
    case "show_widget": return "🖼️";
    default: return "🛠️";
  }
}

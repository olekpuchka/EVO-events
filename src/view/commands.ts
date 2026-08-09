// The one list of commands: bot.ts publishes it as Telegram's menu, helpBody prints it. Adding
// one means an entry here plus its `bot.command(...)` handler.
// Type-only import — i18n.ts imports this list at runtime, so a value import back would cycle.
import type { LabelKey } from "./i18n.ts";

// is_ephemeral hides the invoking "/command" from everyone but its sender. Its reply restrictions
// apply to replying *to* one, so /cancel's "reply to the event you mean" scoping is unaffected.
// `satisfies`, not an annotation: a misspelled key fails typecheck instead of printing "undefined".
export const COMMANDS = [
  { command: "cancel", key: "cmdCancel", is_ephemeral: true },
  { command: "mute", key: "cmdMute", is_ephemeral: true },
  { command: "unmute", key: "cmdUnmute", is_ephemeral: true },
  { command: "faceit", key: "cmdFaceit", is_ephemeral: true },
  { command: "help", key: "cmdHelp", is_ephemeral: true },
] satisfies readonly { command: string; key: LabelKey; is_ephemeral: boolean }[];

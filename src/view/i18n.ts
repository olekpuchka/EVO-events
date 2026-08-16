// Every user-visible string. Ukrainian only — the group is Ukrainian, and the EN branch was
// never a real second language: its AI style block was one sentence against UA's full one, and
// the phrase checks only ever ran for UA. Dropping it also drops the trap where a missing key
// warned to the console and shipped English into the group.

import { COMMANDS } from "./commands.ts";
import { escapeHtml } from "./html.ts";

type Label = string | ((...args: any[]) => string);

// `satisfies`, not an annotation: it checks every value is a Label while keeping the key
// union narrow, which is what lets t() reject a typo at compile time.
const LABELS = {
  groupOnly: "Ця команда працює тільки в групових чатах.",
  noMembers: "Учасників ще не зареєстровано.\n\nЩоб потрапити у список для згадування, потрібно використати <code>/mute</code> або <code>/unmute</code>.",
  usageAll: "Вкажи назву події та час, наприклад:\n<code>@all CS 22:00</code>",
  mentioned: "Згадані:",
  noActiveEvent: "Немає активної події для скасування.",
  replyNotAnEvent: "Це повідомлення не є активною подією — можливо, вона вже завершилась. Відповідай на подію, яку хочеш скасувати, або надішли <code>/cancel</code> окремо.",
  pickEventToCancel: (list) => `Активних подій кілька. Натисни на потрібну нижче, потім <b>відповідай</b> на неї командою <code>/cancel</code> — свайп на телефоні, правий клік → Відповісти на комп'ютері.\n\n${list}`,
  cancelledBy: (mention) => `Скасовано ${mention}`,
  alreadyMuted: "Ти вже не в списку згадувань — @all тебе не згадує.",
  mutedSuccess: "Тебе замучено. @all більше не згадуватиме тебе в цій групі.\nВикористай /unmute, щоб увімкнути назад.",
  alreadyUnmuted: "Ти вже в списку згадувань — @all тебе згадує.",
  unmutedSuccess: "Тебе додано до списку згадувань. @all тепер згадуватиме тебе в цій групі.",
  eventEnded: "Ця подія вже завершилась.",
  cmdCancel: "Скасувати активну подію",
  cmdMute: "Не згадувати мене в @all",
  cmdUnmute: "Згадувати мене в @all",
  cmdFaceit: "Прив'язати, перевірити або відв'язати акаунт FACEIT",
  cmdHelp: "Як користуватися ботом",
  // One block per form, each a bold header over its own description, blank line between. The
  // two used to share a paragraph and the second wrapped straight onto the first — unreadable.
  // The command list comes from COMMANDS so it can't fall behind the menu.
  // escapeHtml because a cmd* label also feeds setMyCommands, which takes plain text.
  // `: string` breaks the cycle LABELS → t() → keyof typeof LABELS.
  helpBody: (): string => `<b>@all CS 22:00</b>
Згадує всіх і закріплює подію з кнопками.
Нагадування — за 10 хв до старту, відкріплення — на початку.

<b>@all CS</b>
Без часу — тільки згадка, нічого не закріплюється.

<b>Команди</b> — вони ж у меню <b>/</b>
${COMMANDS.map(({ command, key }) => `/${command} — ${escapeHtml(t(key))}`).join("\n")}

<b>Вперше тут?</b>
Надішли /unmute, щоб потрапити в список згадувань.
Надішли /faceit ТвійНікнейм, щоб з'являтися в результатах матчів.`,
  // Sent to the group, not via sendEphemeral: an introduction is for everyone, not the joiner.
  // escapeHtml because a group title is user-set text.
  welcome: (mentions, chatTitle) => `👋 <b>Вітаємо, ${mentions} в ${escapeHtml(chatTitle)}!</b>

Надішли /help — покажу, як усе працює.`,
  alreadyJoining: "🍌 Ти вже в грі!",
  alreadyNotJoining: "❌ Ти вже не береш участь!",
  squadFull: (max) => `🔒 Сквад уже повний (${max}/${max})!`,
  joining: "🍌 Ти в грі!",
  notJoining: "❌ Ти не береш участь!",
  joinButton: "🍌 В грі",
  notJoinButton: "❌ Не буду",
  joiningHeader: (n) => `🍌 <b>В грі (${n}):</b>`,
  notJoiningHeader: (n) => `❌ <b>Не будуть (${n}):</b>`,
  reminderHeader: () => `🔔 <b>Гра через 10 хв</b> 🎮`,
  // 1 місце / 2–4 місця / 5+ місць — any count up to the cap can render, since people are free
  // to drop out after the reminder is already out.
  seatsLeft: (n, mentions) => `📣 <b>Залишилось ${n} ${n === 1 ? "місце" : n < 5 ? "місця" : "місць"}</b> — ${mentions}`,
  openEvent: "Відкрити подію",
  faceitNotLinked: "🎮 У тебе ще немає прив'язаного акаунта FACEIT.\n\nНадішли <code>/faceit ТвійНікнейм</code>, щоб з'являтися в результатах матчів цієї групи.",
  faceitUnavailable: "FACEIT API недоступний, спробуй пізніше.",
  faceitNotFound: (nickname) => `Гравця "${nickname}" не знайдено на FACEIT.`,
  didYouMean: (list) => `Можливо, це хтось із них? Натисни, щоб скопіювати, і надішли.\n\n${list}`,
  faceitNoStats: (nickname) => `У "${nickname}" немає статистики CS2 на FACEIT.`,
  faceitLinked: (nickname, eloStr) => `Прив'язано! <b>${nickname}</b> (${eloStr})`,
  faceitStatus: (nickname, eloStr) => `🎮 Прив'язано до <b>${nickname}</b> (${eloStr})`,
  faceitStatusUnavailable: "🎮 Твій акаунт FACEIT прив'язаний, але деталі зараз не завантажились.",
  faceitLinkHelp: "Надішли <code>/faceit &lt;нікнейм&gt;</code>, щоб прив'язати інший акаунт, або <code>/faceit off</code>, щоб відв'язати.",
  faceitUnlinked: "🎮 Відв'язано — твоя статистика більше не з'являтиметься в результатах матчів цієї групи.\n\nНадішли <code>/faceit ТвійНікнейм</code>, щоб прив'язати.",
  unranked: "Без рангу",
  scorePlayer: "Гравець",
  viewOnFaceit: "Дивитись на",
  fallbackHype: "Банан-сквад, підйом! 🍌",
  fallbackWin: "МИ ПОВЕРНУЛИСЬ 🍌🍌🍌",
  fallbackLoss: "Їхні VAC-чисті акаунти грали підозріло добре 🤔",
} satisfies Record<string, Label>;

// Exported for commands.ts, which names label keys without importing LABELS.
export type LabelKey = keyof typeof LABELS;

// A missing key is a typecheck failure, not a runtime warning — worth having when typecheck
// is the only gate. Every call site passes a literal, so nothing needs a dynamic-key escape.
export function t(key: LabelKey, ...args: any[]): string {
  const entry: Label = LABELS[key];
  return typeof entry === "function" ? entry(...args) : entry;
}

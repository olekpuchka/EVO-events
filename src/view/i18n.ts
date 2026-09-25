// Every user-visible string. Ukrainian only — the group is Ukrainian, and the EN branch was
// never a real second language: its AI style block was one sentence against UA's full one, and
// the phrase checks only ever ran for UA. Dropping it also drops the trap where a missing key
// warned to the console and shipped English into the group.

import type { InputRichBlock, RichBlockTableCell, RichText } from "@grammyjs/types";
import { COMMANDS } from "./commands.ts";
import { escapeHtml } from "./html.ts";

type Label = string | ((...args: any[]) => string);

// How a command is written inside a message: bare when it takes no argument, so Telegram makes it
// tappable and one tap runs it; in <code> when it takes one, so it can be copied and edited. The
// argument is always a placeholder — ТвійНікнейм, ДД-ММ-РРРР — never a real value, since <code> is
// tap-to-copy and one tap would store somebody else's nickname or birthday.
//
// `satisfies`, not an annotation: it checks every value is a Label while keeping the key
// union narrow, which is what lets t() reject a typo at compile time.
const LABELS = {
  groupOnly: "Ця команда працює тільки в групових чатах.",
  // /unmute only: /mute registers you too, but sets notifications_enabled to 0, and getMembers
  // filters on 1 — so it leaves you out of the very list this sentence offers to put you in.
  noMembers: "Учасників ще не зареєстровано.\n\nЩоб потрапити в список згадувань, надішли /unmute.",
  usageAll: "Вкажи назву події та час, наприклад:\n<code>@all CS 22:00</code>",
  mentioned: "Згадані:",
  noActiveEvent: "Немає активної події для скасування.",
  replyNotAnEvent: "Це повідомлення не є активною подією — можливо, вона вже завершилась. Відповідай на подію, яку хочеш скасувати, або надішли /cancel окремо.",
  pickEventToCancel: (list) => `Активних подій кілька. Натисни на потрібну нижче, потім <b>відповідай</b> на неї командою /cancel — свайп на телефоні, правий клік → Відповісти на комп'ютері.\n\n${list}`,
  cancelledBy: (mention) => `Скасовано ${mention}`,
  alreadyMuted: "Ти вже не в списку згадувань — @all тебе не згадує.",
  mutedSuccess: "Тебе замучено. @all більше не згадуватиме тебе в цій групі.\nНадішли /unmute, щоб повернутися.",
  alreadyUnmuted: "Ти вже в списку згадувань — @all тебе згадує.",
  unmutedSuccess: "Тебе додано до списку згадувань. @all тепер згадуватиме тебе в цій групі.",
  eventEnded: "Ця подія вже завершилась.",
  cmdCancel: "Скасувати активну подію",
  cmdMute: "Не згадувати мене в @all",
  cmdUnmute: "Згадувати мене в @all",
  cmdFaceit: "Прив'язати, перевірити або відв'язати акаунт FACEIT",
  cmdBirthday: "Додати, перевірити або прибрати свій день народження",
  cmdHelp: "Як користуватися ботом",
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
  faceitNotFound: (nickname) => `Гравця «${nickname}» не знайдено на FACEIT.`,
  didYouMean: (list) => `Можливо, це хтось із них? Натисни, щоб скопіювати, і надішли.\n\n${list}`,
  faceitNoStats: (nickname) => `У «${nickname}» немає статистики CS2 на FACEIT.`,
  // "Прив'язано:" confirms the action just taken, "Прив'язано до" reports standing state — the
  // same split birthdaySaved and birthdayStatus make.
  faceitLinked: (nickname, eloStr) => `🎮 Прив'язано: <b>${nickname}</b> (${eloStr}).`,
  faceitStatus: (nickname, eloStr) => `🎮 Прив'язано до <b>${nickname}</b> (${eloStr}).`,
  faceitStatusUnavailable: "🎮 Твій акаунт FACEIT прив'язаний, але деталі зараз не завантажились.",
  faceitLinkHelp: "Надішли <code>/faceit ТвійНікнейм</code>, щоб прив'язати інший акаунт, або <code>/faceit off</code>, щоб відв'язати.",
  faceitUnlinked: "🎮 Відв'язано — твоя статистика більше не з'являтиметься в результатах матчів цієї групи.\n\nНадішли <code>/faceit ТвійНікнейм</code>, щоб прив'язати.",
  unranked: "Без рангу",
  scorePlayer: "Гравець",
  viewOnFaceit: "Дивитись на",
  // Serves both the usage hint and an unparsable date — naming the format is all either can say.
  birthdayUsage: "Надішли <code>/birthday ДД-ММ-РРРР</code> — наприклад, 25-08-1990.\n\nДата має існувати і бути в минулому.",
  birthdayNotSet: "🎂 Ти ще не додав свій день народження.",
  // The age is a check, not decoration: nothing else catches a year typed 2004 instead of 1994.
  birthdaySaved: (date, age) => `🎂 Записано: <b>${date}</b> (зараз тобі ${age}).\n\nУ цей день чат тебе привітає.`,
  birthdayStatus: (date, age) => `🎂 Твій день народження: <b>${date}</b> (зараз тобі ${age}).`,
  birthdayChangeHelp: "Надішли <code>/birthday ДД-ММ-РРРР</code>, щоб змінити дату, або <code>/birthday off</code>, щоб прибрати.",
  birthdayRemoved: "🎂 Прибрано — чат більше не вітатиме тебе автоматично.\n\nНадішли <code>/birthday ДД-ММ-РРРР</code>, щоб додати знову.",
  // Sent to the group like the welcome — a greeting only its subject can see makes no sense.
  // The AI toast goes under this line.
  birthdayGreeting: (mention, age) => `🎂 <b>З днем народження, ${mention}!</b> <i>(${age})</i>`,
  // Long on purpose: a one-liner under the greeting header would read as a bug.
  fallbackBirthday: `Сьогодні свято, і воно не в календарі — воно в нашому лоббі.

Бажаємо тобі стабільного пінгу, чесного сабтіку і тіммейтів, які не продають раунд за тридцять секунд до кінця. Хай кожен твій постріл знаходить голову, кожен клатч закривається, а кожна «одна катка» триває рівно стільки, скільки ти сам захочеш.

І головне — здоров'я, спокою і людей поруч, з якими не шкода просидіти до четвертої ранку. З днем народження 🎂`,
} satisfies Record<string, Label>;

// Exported for commands.ts, which names label keys without importing LABELS.
export type LabelKey = keyof typeof LABELS;

// A missing key is a typecheck failure, not a runtime warning — worth having when typecheck
// is the only gate. Every call site passes a literal, so nothing needs a dynamic-key escape.
export function t(key: LabelKey, ...args: any[]): string {
  const entry: Label = LABELS[key];
  return typeof entry === "function" ? entry(...args) : entry;
}

// /help as rich blocks. The command table comes from COMMANDS, so it can't fall behind the menu.
export function helpBlocks(): InputRichBlock<never>[] {
  const cell = (text: RichText): RichBlockTableCell => ({ text, align: "left", valign: "middle" });
  const code = (text: string): RichText => ({ type: "code", text });
  const step = (text: RichText): { blocks: InputRichBlock<never>[] } => ({ blocks: [{ type: "paragraph", text }] });

  return [
    { type: "heading", size: 5, text: "Події" },
    { type: "paragraph", text: [code("@all CS 22:00"), " — згадує всіх і закріплює подію з кнопками. Нагадування — за 10 хв до старту, відкріплення — на початку."] },
    { type: "paragraph", text: [code("@all CS"), " — без часу: тільки згадка, нічого не закріплюється."] },
    { type: "heading", size: 5, text: "Команди" },
    {
      type: "table", is_striped: true, is_compact: true,
      cells: COMMANDS.map(({ command, key }) => [cell({ type: "bot_command", text: `/${command}`, bot_command: `/${command}` }), cell(t(key))]),
      caption: "Вони ж у меню /",
    },
    { type: "heading", size: 5, text: "Вперше тут?" },
    {
      type: "list",
      items: [
        step(["Надішли ", { type: "bot_command", text: "/unmute", bot_command: "/unmute" }, ", щоб потрапити в список згадувань."]),
        step(["Надішли ", code("/faceit ТвійНікнейм"), ", щоб з'являтися в результатах матчів."]),
        step(["Надішли ", code("/birthday ДД-ММ-РРРР"), ", щоб чат привітав тебе з днем народження."]),
      ],
    },
  ];
}

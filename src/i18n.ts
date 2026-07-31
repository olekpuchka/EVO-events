const SUPPORTED = ["EN", "UA"] as const;
type Lang = (typeof SUPPORTED)[number];

const DEFAULT_LANG: Lang = "UA";

// `||`, not `??`, so an empty LANGUAGE= in a .env falls back rather than failing the check below.
const requested = (process.env.LANGUAGE || DEFAULT_LANG).toUpperCase();
const supported = SUPPORTED.includes(requested as Lang);
if (!supported) {
  console.warn(`[i18n] Unknown LANGUAGE "${process.env.LANGUAGE}", falling back to ${DEFAULT_LANG}.`);
}
export const LANG: Lang = supported ? (requested as Lang) : DEFAULT_LANG;

type Label = string | ((...args: any[]) => string);

const LABELS: Record<Lang, Record<string, Label>> = {
  EN: {
    groupOnly: "This command only works in group chats.",
    noMembers: "No members registered yet.\n\nMembers need to use <code>/mute</code> or <code>/unmute</code> to be added to the mention list.",
    usageAll: "Please include an event name and time, e.g.:\n<code>@all CS 22:00</code>",
    mentioned: "Mentioned:",
    noActiveEvent: "There is no active event to cancel.",
    replyNotAnEvent: "That message isn't an active event — it may have already ended. Reply to the event you want to cancel, or send <code>/cancel</code> on its own.",
    pickEventToCancel: (list) => `More than one event is active. Tap one below, then <b>reply</b> to it with <code>/cancel</code> — swipe on mobile, right-click → Reply on desktop.\n\n${list}`,
    cancelledBy: (mention) => `Cancelled by ${mention}`,
    alreadyMuted: "You are already muted — @all won't mention you.",
    mutedSuccess: "You've been muted. You won't be mentioned by @all in this group.\nUse /unmute to re-enable.",
    alreadyUnmuted: "You are already unmuted and will be mentioned by @all.",
    unmutedSuccess: "You've been added to the mention list. You'll be mentioned by @all in this group.",
    eventEnded: "This event has already ended.",
    cmdCancel: "Cancel an active event",
    cmdMute: "Don't mention me in @all",
    cmdUnmute: "Mention me in @all",
    cmdFaceit: "Link or check your FACEIT account",
    cmdHelp: "How to use the bot",
    helpBody: `<b>@all CS 22:00</b> — mentions everyone and pins an event with RSVP buttons. A reminder goes out 10 min before, and it unpins at start time.
<b>@all CS</b> — no time, so it only mentions everyone.

Every command is in the <b>/</b> menu.
New here? Send /unmute to get on the list.`,
    alreadyJoining: "🍌 You're already joining!",
    alreadyNotJoining: "❌ You're already not joining!",
    squadFull: (max) => `🔒 Squad's already full (${max}/${max})!`,
    joining: "🍌 You're joining!",
    notJoining: "❌ You aren't joining!",
    joinButton: "🍌 Joining",
    notJoinButton: "❌ Not joining",
    joiningHeader: (n) => `🍌 <b>Joining (${n}):</b>`,
    notJoiningHeader: (n) => `❌ <b>Not joining (${n}):</b>`,
    reminderHeader: () => `🔔 <b>Game in 10 min</b> 🎮`,
    seatsLeft: (n, mentions) => `📣 <b>${n} seat${n === 1 ? "" : "s"} left</b> — ${mentions}`,
    openEvent: "Open event",
    faceitNotLinked: "🎮 You don't have a FACEIT account linked yet.\n\nSend <code>/faceit YourNickname</code> to show up in this group's match results.",
    faceitUnavailable: "FACEIT API is unavailable, try again later.",
    faceitNotFound: (nickname) => `Player "${nickname}" not found on FACEIT.`,
    didYouMean: (list) => `Did you mean one of these? Tap to copy, then send it.\n\n${list}`,
    faceitNoStats: (nickname) => `"${nickname}" has no CS2 stats on FACEIT.`,
    faceitLinked: (nickname, eloStr) => `Linked! <b>${nickname}</b> (${eloStr})`,
    faceitStatus: (nickname, eloStr) => `🎮 Linked to <b>${nickname}</b> (${eloStr})`,
    faceitStatusUnavailable: "🎮 Your FACEIT account is linked, but its details couldn't be loaded right now.",
    faceitLinkHelp: "Send <code>/faceit &lt;nickname&gt;</code> to link a different account, or <code>/faceit off</code> to unlink.",
    faceitUnlinked: "🎮 Unlinked — your stats won't appear in this group's match results any more.\n\nSend <code>/faceit YourNickname</code> to link.",
    unranked: "Unranked",
    scorePlayer: "Player",
    viewOnFaceit: "View on",
    fallbackHype: "Banana squad, rise up! 🍌",
    fallbackWin: "WE ARE SO BACK 🍌🍌🍌",
    fallbackLoss: "Their VAC-clean accounts played suspiciously well 🤔",
  },
  UA: {
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
    cmdFaceit: "Прив'язати або перевірити акаунт FACEIT",
    cmdHelp: "Як користуватися ботом",
    helpBody: `<b>@all CS 22:00</b> — згадує всіх і закріплює подію з кнопками. Нагадування — за 10 хв до старту, відкріплення — на початку.
<b>@all CS</b> — без часу, тільки згадка.

Усі команди — у меню <b>/</b>.

Вперше тут? Надішли /unmute щоб потрапити в список.`,
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
  },
};

export function t(key: string, ...args: any[]): string {
  let entry: Label | undefined = LABELS[LANG][key];
  if (entry === undefined) {
    console.warn(`[i18n] Missing key "${key}" for language "${LANG}", falling back to EN.`);
    entry = LABELS.EN[key] as Label | undefined;
  }
  // Missing in every language — return the key itself, so the `: string` return never lies.
  return typeof entry === "function" ? entry(...args) : entry ?? key;
}

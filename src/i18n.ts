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
    cmdMute: "Stop being mentioned by @all",
    cmdUnmute: "Resume being mentioned by @all",
    cmdFaceit: "Link your FACEIT account",
    cmdHelp: "How to use the bot",
    helpBody: (max) => `🍌 <b>EVO Events</b>

<b>@all CS 22:00</b> — mentions everyone and pins an event with RSVP buttons. A reminder goes out 10 min before, and it unpins at start time.
<b>@all CS</b> — no time, so it only mentions everyone.

The squad caps at ${max} — drop out to free a seat.

<b>Commands</b>
/cancel — cancel an active event. With more than one live, reply to the one you mean.
/faceit &lt;nickname&gt; — link FACEIT so match results post here.
/mute · /unmute — stop or resume being mentioned by @all. New here? Send /unmute once to get on the list.`,
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
    faceitUsage: "Usage: /faceit &lt;your FACEIT nickname&gt;",
    faceitUnavailable: "FACEIT API is unavailable, try again later.",
    faceitNotFound: (nickname) => `Player "${nickname}" not found on FACEIT.`,
    faceitNoStats: (nickname) => `"${nickname}" has no CS2 stats on FACEIT.`,
    faceitLinked: (nickname, eloStr) => `Linked! <b>${nickname}</b> (${eloStr})`,
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
    alreadyMuted: "Ти вже в муті — @all не буде тебе згадувати.",
    mutedSuccess: "Тебе замучено. @all більше не згадуватиме тебе в цій групі.\nВикористай /unmute, щоб увімкнути назад.",
    alreadyUnmuted: "Ти вже не в муті, @all тебе згадуватиме.",
    unmutedSuccess: "Тебе додано до списку згадувань. @all тепер згадуватиме тебе в цій групі.",
    eventEnded: "Ця подія вже завершилась.",
    cmdCancel: "Скасувати активну подію",
    cmdMute: "Не згадувати мене в @all",
    cmdUnmute: "Знову згадувати мене в @all",
    cmdFaceit: "Прив'язати акаунт FACEIT",
    cmdHelp: "Як користуватися ботом",
    helpBody: (max) => `🍌 <b>EVO Events</b>

<b>@all CS 22:00</b> — згадує всіх і закріплює подію з кнопками. Нагадування — за 10 хв до старту, відкріплення — на початку.
<b>@all CS</b> — без часу, тільки згадка.

Загін максимум ${max} — вийди, щоб звільнити місце.

<b>Команди</b>
/cancel — скасувати активну подію. Якщо їх кілька — відповідай на потрібну.
/faceit &lt;нікнейм&gt; — прив'язати FACEIT, щоб тут з'являлись результати матчів.
/mute · /unmute — не згадувати / знову згадувати в @all. Вперше тут? Надішли /unmute один раз, щоб потрапити в список.`,
    alreadyJoining: "🍌 Ти вже в грі!",
    alreadyNotJoining: "❌ Ти вже не береш участь!",
    squadFull: (max) => `🔒 Загін уже повний (${max}/${max})!`,
    joining: "🍌 Ти в грі!",
    notJoining: "❌ Ти не береш участь!",
    joinButton: "🍌 В грі",
    notJoinButton: "❌ Не буду",
    joiningHeader: (n) => `🍌 <b>В грі (${n}):</b>`,
    notJoiningHeader: (n) => `❌ <b>Не будуть (${n}):</b>`,
    reminderHeader: () => `🔔 <b>Гра через 10 хв</b> 🎮`,
    faceitUsage: "Використання: /faceit &lt;твій нікнейм FACEIT&gt;",
    faceitUnavailable: "FACEIT API недоступний, спробуй пізніше.",
    faceitNotFound: (nickname) => `Гравця "${nickname}" не знайдено на FACEIT.`,
    faceitNoStats: (nickname) => `У "${nickname}" немає статистики CS2 на FACEIT.`,
    faceitLinked: (nickname, eloStr) => `Прив'язано! <b>${nickname}</b> (${eloStr})`,
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

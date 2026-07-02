const SUPPORTED = ["EN", "UA"];
const requested = (process.env.LANGUAGE ?? "EN").toUpperCase();
if (!SUPPORTED.includes(requested)) {
  console.warn(`[i18n] Unknown LANGUAGE "${process.env.LANGUAGE}", falling back to EN.`);
}
export const LANG = SUPPORTED.includes(requested) ? requested : "EN";

const LABELS = {
  EN: {
    groupOnly: "This command only works in group chats.",
    noMembers: "No members registered yet.\n\nMembers need to use <code>/mute</code> or <code>/unmute</code> to be added to the mention list.",
    usageAll: "Please include an event name and time, e.g.:\n<code>@all CS 22:00</code>",
    mentioned: "Mentioned:",
    activeEventExists: (link) => `There is already <a href="${link}">an active event</a>. It will be unpinned automatically when it ends.`,
    noActiveEvent: "There is no active event to cancel.",
    cancelledBy: (mention) => `Cancelled by ${mention}`,
    alreadyMuted: "You are already muted — @all won't mention you.",
    mutedSuccess: "You've been muted. You won't be mentioned by @all in this group.\nUse /unmute to re-enable.",
    alreadyUnmuted: "You are already unmuted and will be mentioned by @all.",
    unmutedSuccess: "You've been added to the mention list. You'll be mentioned by @all in this group.",
    eventEnded: "This event has already ended.",
    alreadyJoining: "🍌 You're already joining!",
    alreadyNotJoining: "❌ You're already not joining!",
    squadFull: (max) => `🔒 Squad's already full (${max}/${max})!`,
    joinedFull: (phrase, max) => `🔥 You're in! ${phrase} (${max}/${max}) 🔒`,
    joining: "🍌 You're joining!",
    notJoining: "❌ You aren't joining!",
    joinButton: "🍌 Joining",
    notJoinButton: "❌ Not joining",
    joiningHeader: (n) => `🍌 <b>Joining (${n}):</b>`,
    notJoiningHeader: (n) => `❌ <b>Not joining (${n}):</b>`,
    reminderHeader: () => `🔔 <b>Reminder!</b> Event starts in <b>10 minutes</b> 🎮`,
    faceitUsage: "Usage: /faceit &lt;your FACEIT nickname&gt;",
    faceitUnavailable: "FACEIT API is unavailable, try again later.",
    faceitNotFound: (nickname) => `Player "${nickname}" not found on FACEIT.`,
    faceitNoStats: (nickname) => `"${nickname}" has no CS2 stats on FACEIT.`,
    faceitLinked: (nickname, eloStr) => `Linked! <b>${nickname}</b> (${eloStr})`,
    unranked: "Unranked",
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
    activeEventExists: (link) => `Вже є <a href="${link}">активна подія</a>. Вона автоматично відкріпиться, коли завершиться.`,
    noActiveEvent: "Немає активної події для скасування.",
    cancelledBy: (mention) => `Скасовано ${mention}`,
    alreadyMuted: "Ти вже в муті — @all не буде тебе згадувати.",
    mutedSuccess: "Тебе замучено. @all більше не згадуватиме тебе в цій групі.\nВикористай /unmute, щоб увімкнути назад.",
    alreadyUnmuted: "Ти вже не в муті, @all тебе згадуватиме.",
    unmutedSuccess: "Тебе додано до списку згадувань. @all тепер згадуватиме тебе в цій групі.",
    eventEnded: "Ця подія вже завершилась.",
    alreadyJoining: "🍌 Ти вже в грі!",
    alreadyNotJoining: "❌ Ти вже не береш участь!",
    squadFull: (max) => `🔒 Загін уже повний (${max}/${max})!`,
    joinedFull: (phrase, max) => `🔥 Ти в грі! ${phrase} (${max}/${max}) 🔒`,
    joining: "🍌 Ти в грі!",
    notJoining: "❌ Ти не береш участь!",
    joinButton: "🍌 В грі",
    notJoinButton: "❌ Не буду",
    joiningHeader: (n) => `🍌 <b>В грі (${n}):</b>`,
    notJoiningHeader: (n) => `❌ <b>Не будуть (${n}):</b>`,
    reminderHeader: () => `🔔 <b>Нагадування!</b> Подія починається через <b>10 хвилин</b> 🎮`,
    faceitUsage: "Використання: /faceit &lt;твій нікнейм FACEIT&gt;",
    faceitUnavailable: "FACEIT API недоступний, спробуй пізніше.",
    faceitNotFound: (nickname) => `Гравця "${nickname}" не знайдено на FACEIT.`,
    faceitNoStats: (nickname) => `У "${nickname}" немає статистики CS2 на FACEIT.`,
    faceitLinked: (nickname, eloStr) => `Прив'язано! <b>${nickname}</b> (${eloStr})`,
    unranked: "Без рангу",
    viewOnFaceit: "Дивитись на",
    fallbackHype: "Банан-сквад, підйом! 🍌",
    fallbackWin: "МИ ПОВЕРНУЛИСЬ 🍌🍌🍌",
    fallbackLoss: "Їхні VAC-чисті акаунти грали підозріло добре 🤔",
  },
};

export function t(key, ...args) {
  let entry = LABELS[LANG][key];
  if (entry === undefined) {
    console.warn(`[i18n] Missing key "${key}" for language "${LANG}", falling back to EN.`);
    entry = LABELS.EN[key];
  }
  return typeof entry === "function" ? entry(...args) : entry;
}

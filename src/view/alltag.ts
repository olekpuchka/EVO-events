// The @all trigger: finding the tag anywhere in a message and cutting it out of the event text.

// A standalone word only — not @allin or a@all.com. Trailing punctuation goes with the tag.
// Global is safe: both match() and replace() reset lastIndex.
export const ALL_TAG = /(?<=^|\s)@all[,.!?:;]*(?=\s|$)/gi;

export const stripAllTag = (text: string): string =>
  text.replace(ALL_TAG, "").replace(/[ \t]{2,}/g, " ").trim();

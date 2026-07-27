/**
 * Prints sample AI phrases against the live DeepSeek API, so prompt changes can
 * be judged before they reach the chat.
 *
 *   node --env-file=.env scripts/ai-preview.ts          # 3 of each kind
 *   node --env-file=.env scripts/ai-preview.ts 6        # 6 of each kind
 *
 * Writes its phrase history to ./.preview-data so a preview run never pollutes
 * the real anti-repeat history in DATA_DIR.
 */

process.env.DATA_DIR ??= "./.preview-data";

// imported late: db.ts resolves DATA_DIR at module load
const { generateHypePhrase, generateMatchPhrase } = await import("../src/ai.ts");
import type { MatchPlayer } from "../src/types.ts";

const RUNS = Number(process.argv[2] ?? 3);

const player = (over: Partial<MatchPlayer> = {}): MatchPlayer => ({
  nickname: "Winfle",
  kills: 16,
  deaths: 8,
  assists: 8,
  adr: 117.9,
  hs: 56,
  aces: 0,
  quadros: 0,
  clutches: 0,
  awp: 0,
  entries: 0,
  util: 318,
  flashes: 4,
  ...over,
});

interface Scenario {
  name: string;
  run: () => Promise<string>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "HYPE — squad filled up",
    run: () => generateHypePhrase("CS"),
  },
  {
    name: "WIN — comfortable, standout player",
    run: () =>
      generateMatchPhrase(true, "13:5", {
        map: "Dust2",
        elo: { ours: 1058, theirs: 1067 },
        players: [player()],
        matchFlow: { ourFirst: 8, theirFirst: 4, ourOt: 0, theirOt: 0 },
      }),
  },
  {
    name: "WIN — comeback in overtime, clutch player",
    run: () =>
      generateMatchPhrase(true, "22:19", {
        map: "Ancient",
        elo: { ours: 1029, theirs: 1007 },
        players: [player({ nickname: "kiko____", clutches: 2, adr: 104.2 })],
        matchFlow: { ourFirst: 4, theirFirst: 8, ourOt: 9, theirOt: 6 },
      }),
  },
  {
    name: "WIN — upset against a much higher-rated team",
    run: () =>
      generateMatchPhrase(true, "13:10", {
        map: "Mirage",
        elo: { ours: 1831, theirs: 1975 },
        players: [player({ nickname: "trascend", aces: 1, adr: 132.4 })],
        matchFlow: { ourFirst: 7, theirFirst: 5, ourOt: 0, theirOt: 0 },
      }),
  },
  {
    name: "LOSS — run over",
    run: () =>
      generateMatchPhrase(false, "3:13", {
        map: "Nuke",
        elo: { ours: 1971, theirs: 1958 },
        matchFlow: { ourFirst: 2, theirFirst: 10, ourOt: 0, theirOt: 0 },
      }),
  },
  {
    name: "LOSS — by a hair in overtime",
    run: () =>
      generateMatchPhrase(false, "14:16", {
        map: "Nuke",
        elo: { ours: 1957, theirs: 1919 },
        matchFlow: { ourFirst: 7, theirFirst: 5, ourOt: 2, theirOt: 4 },
      }),
  },
  {
    name: "LOSS — upset, they were rated much lower",
    run: () =>
      generateMatchPhrase(false, "5:13", {
        map: "Inferno",
        elo: { ours: 1116, theirs: 1010 },
        matchFlow: { ourFirst: 3, theirFirst: 9, ourOt: 0, theirOt: 0 },
      }),
  },
];

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is not set — every phrase would be a static fallback.");
  process.exit(1);
}

for (const scenario of SCENARIOS) {
  console.log(`\n${"─".repeat(72)}\n${scenario.name}\n${"─".repeat(72)}`);
  // sequential on purpose: each phrase must see the previous one in history,
  // which is exactly the anti-repeat path worth eyeballing
  for (let i = 0; i < RUNS; i++) {
    console.log(`  • ${await scenario.run()}`);
  }
}

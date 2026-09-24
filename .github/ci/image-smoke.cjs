// Run inside the built image by CI: proves node-tls-client's native library loads there. A 403 or
// 429 from faceit.com still passes — the runner's IP may be challenged, but the library answered.
import("../../src/adapters/faceit.ts").then(async ({ getMatchScoreboard }) => {
  let workerFailed = false;
  const log = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes("tls worker failed")) workerFailed = true;
    log(...args);
  };
  try {
    const board = await getMatchScoreboard("1-b44d1826-358c-4448-b30e-8c09c534a78b");
    console.log(`scoreboard ok: ${board.size} players`);
  } catch (err) {
    if (!/^faceit\.com \d+$/.test(err.message)) {
      console.log(`library failed: ${err.message}`);
      process.exit(1);
    }
    console.log(`library loaded; faceit.com answered ${err.message}`);
  }
  // Idle workers boot on their own; give them time to fail if the library is broken.
  await new Promise(resolve => setTimeout(resolve, 3000));
  if (workerFailed) {
    console.log("an idle worker could not load the library");
    process.exit(1);
  }
  process.exit(0);
});

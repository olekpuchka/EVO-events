// Run in the built image by CI: proves the TLS library loads and completes a request, signed in (a fake
// cookie) and anonymously. A real HTTP status passes — the runner's IP may be challenged — but 0 fails.
process.env.FACEIT_COOKIE = "ci-smoke";
const fs = require("node:fs");
const os = require("node:os");
const version = require("node-tls-client/package.json").version;
import("../../src/adapters/faceit.ts").then(async ({ getMatchScoreboard, CHROME }) => {
  try {
    const board = await getMatchScoreboard("1-b44d1826-358c-4448-b30e-8c09c534a78b");
    console.log(`scoreboard ok: ${board.size} players`);
  } catch (err) {
    if (!/^faceit\.com [1-9]\d*:/.test(err.message)) {
      console.log(`library failed: ${err.message}`);
      process.exit(1);
    }
    console.log(`library loaded; faceit.com answered ${err.message}`);
  }
  // Only the pinned build the Dockerfile baked, as root: a download would be botuser's, even under its name.
  const name = `tls-client-${version}-linux-amd64.so`;
  const libs = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("tls-client-"));
  if (libs.join() !== name || fs.statSync(`${os.tmpdir()}/${name}`).uid !== 0) {
    console.log(`expected only the root-owned baked ${name} in ${os.tmpdir()}, found: ${libs.join(", ") || "none"}`);
    process.exit(1);
  }
  // The Go build falls back silently on a profile it doesn't know; its names are plain strings inside it.
  if (!fs.readFileSync(`${os.tmpdir()}/${name}`).includes(`chrome_${CHROME}`)) {
    console.log(`the baked library has no chrome_${CHROME} profile: bump TLS_CLIENT_VERSION in the Dockerfile`);
    process.exit(1);
  }
  process.exit(0);
});

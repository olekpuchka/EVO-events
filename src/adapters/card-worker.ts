// Child process: card markup + image data URIs on stdin (JSON) → PNG on stdout, then exit.
// One render per process — resvg-js leaks native memory on raster images, see **Result card**.

import { readFileSync } from "node:fs";
import satori from "satori";
import { html } from "satori-html";
import { Resvg } from "@resvg/resvg-js";
import { CARD_WIDTH, AVATAR, MAP_SRC } from "../view/card.ts";

const ASSETS = new URL("../../assets/", import.meta.url);
const asset = (path: string): Buffer => readFileSync(new URL(path, ASSETS));

// Node's own crash report opens with the throwing source line — all 64 KB of minified satori.
process.on("uncaughtException", err => {
  process.stderr.write(`${err.name}: ${err.message}\n`, () => process.exit(1));
});

// The markup, and a data URI for each image `src` in it.
interface Job { markup: string; images: Record<string, string> }

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Job;

type Node = { type: string; props: { src?: string; children?: unknown } };
// satori-html is quadratic on a long attribute, so the data URIs go in after parsing.
function swapImages(node: Node): void {
  if (node.type === "img" && node.props.src !== undefined) {
    const uri = job.images[node.props.src];
    if (!uri) throw new Error(`markup has image ${node.props.src} but no bytes were sent`);
    node.props.src = uri;
  }
  for (const child of [node.props.children].flat()) {
    if (child && typeof child === "object") swapImages(child as Node);
  }
}

// The card renders at 4x; an avatar is shrunk to the pixels it is drawn at.
const ZOOM = 4;
const AVATAR_PX = AVATAR * ZOOM;

// Averages a 4×4 grid of sub-pixel draws: resvg samples without averaging, so one big shrink aliases.
const GRID = 4;
function shrink(uri: string): string {
  let draws = "";
  for (let i = 0; i < GRID * GRID; i++) {
    const [x, y] = [i % GRID, Math.floor(i / GRID)].map(v => (v + 0.5) / GRID - 0.5);
    draws += `<use href="#a" x="${x}" y="${y}" opacity="${1 / (i + 1)}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_PX}" height="${AVATAR_PX}"><defs>` +
    `<image id="a" href="${uri}" width="${AVATAR_PX}" height="${AVATAR_PX}" preserveAspectRatio="xMidYMid slice"/></defs>${draws}</svg>`;
  return `data:image/png;base64,${Buffer.from(new Resvg(svg).render().asPng()).toString("base64")}`;
}

for (const src of Object.keys(job.images)) {
  if (src !== MAP_SRC) job.images[src] = shrink(job.images[src]!);
}

const tree = html(job.markup) as unknown as Node;
swapImages(tree);

const svg = await satori(tree as Parameters<typeof satori>[0], {
  width: CARD_WIDTH,
  fonts: [
    { name: "DejaVu", data: asset("fonts/DejaVuSans.ttf"), weight: 400 },
    { name: "DejaVu", data: asset("fonts/DejaVuSans-Bold.ttf"), weight: 700 },
  ],
});

process.stdout.write(new Resvg(svg, { fitTo: { mode: "zoom", value: ZOOM } }).render().asPng());

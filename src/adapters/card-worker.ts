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

// The PNG is drawn at this multiple of the markup; an avatar is shrunk to the pixels it fills.
const ZOOM = 2;
const AVATAR_PX = AVATAR * ZOOM;

// A 4×4 grid of sub-pixel draws, averaged: resvg samples without averaging, so one big shrink aliases.
const GRID = 4;
const offset = (v: number): number => (v + 0.5) / GRID - 0.5;
let DRAWS = "";
for (let y = 0, n = 1; y < GRID; y++) {
  for (let x = 0; x < GRID; x++, n++) DRAWS += `<use href="#a" x="${offset(x)}" y="${offset(y)}" opacity="${1 / n}"/>`;
}

// An avatar shrunk to the pixels it is drawn at, as a PNG data URI.
function shrink(src: string, uri: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_PX}" height="${AVATAR_PX}"><defs>` +
    `<image id="a" href="${uri}" width="${AVATAR_PX}" height="${AVATAR_PX}" preserveAspectRatio="xMidYMid slice"/></defs>${DRAWS}</svg>`;
  const image = new Resvg(svg).render();
  // resvg skips an image it can't decode; without this, a corrupt avatar ships as an empty circle.
  const pixels = image.pixels;
  let opaque = false;
  for (let i = 3; i < pixels.length && !opaque; i += 4) opaque = pixels[i]! > 0;
  if (!opaque) throw new Error(`${src} did not decode`);
  return `data:image/png;base64,${Buffer.from(image.asPng()).toString("base64")}`;
}

for (const [src, uri] of Object.entries(job.images)) {
  if (src !== MAP_SRC) job.images[src] = shrink(src, uri);
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

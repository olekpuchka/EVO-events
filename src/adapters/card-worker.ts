// Child process: card markup + image data URIs on stdin (JSON) → PNG on stdout, then exit.
// One render per process — resvg-js leaks native memory on raster images, see **Result card**.

import { readFileSync } from "node:fs";
import satori from "satori";
import { html } from "satori-html";
import { Resvg } from "@resvg/resvg-js";
import { CARD_WIDTH } from "../view/card.ts";

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

const tree = html(job.markup) as unknown as Node;
swapImages(tree);

const svg = await satori(tree as Parameters<typeof satori>[0], {
  width: CARD_WIDTH,
  fonts: [
    { name: "DejaVu", data: asset("fonts/DejaVuSans.ttf"), weight: 400 },
    { name: "DejaVu", data: asset("fonts/DejaVuSans-Bold.ttf"), weight: 700 },
  ],
});

process.stdout.write(new Resvg(svg, { fitTo: { mode: "zoom", value: 2 } }).render().asPng());

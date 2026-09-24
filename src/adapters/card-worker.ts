// Child process: card markup + map bytes on stdin (JSON) → PNG on stdout, then exit.
// One render per process — resvg-js leaks native memory on raster images, see **Result card**.

import { readFileSync } from "node:fs";
import satori from "satori";
import { html } from "satori-html";
import { Resvg } from "@resvg/resvg-js";
import { CARD_WIDTH, MAP_SRC, mapFormat } from "../view/card.ts";

const ASSETS = new URL("../../assets/", import.meta.url);
const asset = (path: string): Buffer => readFileSync(new URL(path, ASSETS));

interface Job { markup: string; map: string | null }

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Job;

// satori needs the type in the data URI; fetchMapImage has already refused anything else.
function mapUri(base64: string): string {
  const type = mapFormat(Buffer.from(base64, "base64"));
  if (!type) throw new Error("map image is not PNG or JPEG");
  return `data:image/${type};base64,${base64}`;
}

type Node = { type: string; props: { src?: string; children?: unknown } };
// satori-html is quadratic on a long attribute, so the data URI goes in after parsing.
function swapMap(node: Node): void {
  if (node.type === "img" && node.props.src === MAP_SRC) {
    if (!job.map) throw new Error("markup has a map but no image was sent");
    node.props.src = mapUri(job.map);
  }
  for (const child of [node.props.children].flat()) {
    if (child && typeof child === "object") swapMap(child as Node);
  }
}

const tree = html(job.markup) as unknown as Node;
swapMap(tree);

const svg = await satori(tree as Parameters<typeof satori>[0], {
  width: CARD_WIDTH,
  fonts: [
    { name: "DejaVu", data: asset("fonts/DejaVuSans.ttf"), weight: 400 },
    { name: "DejaVu", data: asset("fonts/DejaVuSans-Bold.ttf"), weight: 700 },
  ],
});

process.stdout.write(new Resvg(svg, { fitTo: { mode: "zoom", value: 2 } }).render().asPng());

// Child process: card markup + image data URIs on stdin (JSON) → PNG on stdout, then exit.
// One render per process — resvg-js leaks native memory on raster images, see **Result card**.

import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
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

// satori hands resvg paths, never text, so resvg needs no fonts — left on, every `new Resvg` scans the
// system's, ~150 ms and well over 100 MB a time.
const RESVG = { font: { loadSystemFonts: false } };

// A GRID×GRID box of samples averaged per pixel: resvg samples without averaging, so one big shrink
// aliases. The avatar is drawn once at GRID× and the boxes averaged here — a draw per sample decoded the
// full-size avatar 16 times, and resvg leaks every decode.
const GRID = 4;

// An avatar shrunk to the pixels it is drawn at, as a PNG data URI.
function shrink(src: string, uri: string): string {
  const big = AVATAR_PX * GRID;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${big}" height="${big}">` +
    `<image href="${uri}" width="${big}" height="${big}" preserveAspectRatio="xMidYMid slice"/></svg>`;
  const pixels = new Resvg(svg, RESVG).render().pixels;
  const out = Buffer.alloc(AVATAR_PX * AVATAR_PX * 4);
  let opaque = false;
  for (let y = 0; y < AVATAR_PX; y++) {
    for (let x = 0; x < AVATAR_PX; x++) {
      // Weighted by alpha, so a transparent sample's colour doesn't bleed into the edge.
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < GRID; dy++) {
        for (let dx = 0; dx < GRID; dx++) {
          const i = ((y * GRID + dy) * big + x * GRID + dx) * 4;
          const w = pixels[i + 3]!;
          r += pixels[i]! * w; g += pixels[i + 1]! * w; b += pixels[i + 2]! * w; a += w;
        }
      }
      const o = (y * AVATAR_PX + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / (GRID * GRID));
        opaque = true;
      }
    }
  }
  // resvg skips an image it can't decode; without this, a corrupt avatar ships as an empty circle.
  if (!opaque) throw new Error(`${src} did not decode`);
  return `data:image/png;base64,${encodePng(out, AVATAR_PX).toString("base64")}`;
}

// A square RGBA image as a PNG: resvg encodes only what it renders, and this is already rendered.
function encodePng(rgba: Buffer, size: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  // Each row opens with filter type 0 (none).
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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

process.stdout.write(new Resvg(svg, { ...RESVG, fitTo: { mode: "zoom", value: ZOOM } }).render().asPng());

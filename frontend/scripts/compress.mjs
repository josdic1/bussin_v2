// Writes a .gz twin next to each built JS/CSS/SVG/JSON asset. The server sends
// the twin to browsers that accept gzip, so nothing is compressed per request.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const assets = new URL("../dist/assets/", import.meta.url).pathname;
let count = 0;
for (const file of readdirSync(assets)) {
  if (!/\.(js|mjs|css|svg|json)$/.test(file)) continue;
  const path = join(assets, file);
  const source = readFileSync(path);
  if (source.length < 1024) continue;
  writeFileSync(`${path}.gz`, gzipSync(source, { level: 9 }));
  count += 1;
}
console.log(`Compressed ${count} assets`);

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

// The service worker reads this list on install and saves every code file, so
// Bussin opens fully offline after one visit (including screens not yet opened).
const files = readdirSync(assets).filter((file) => !file.endsWith(".gz")).map((file) => `/assets/${file}`);
writeFileSync(new URL("../dist/asset-list.json", import.meta.url), JSON.stringify(files));
console.log(`Listed ${files.length} assets for offline use`);

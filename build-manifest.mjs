#!/usr/bin/env node
// Scans the markdown folder and writes a manifest the browser reads on load,
// so the app never has to discover files by probing the network.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MARKDOWN_DIR = join(ROOT, "markdowns");
const OUTPUT = join(MARKDOWN_DIR, "manifest.json");

function extractTitle(source, fallback) {
    const match = source.match(/^#\s+(.+)$/m);
    if (!match) return fallback;
    return match[1].replace(/\s+/g, " ").trim();
}

// Numeric names sort as numbers (2 before 10); anything else falls back to
// natural string order.
function compareSlugs(a, b) {
    const na = Number(a.slug);
    const nb = Number(b.slug);
    const aNum = a.slug !== "" && Number.isFinite(na);
    const bNum = b.slug !== "" && Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum) return -1;
    if (bNum) return 1;
    return a.slug.localeCompare(b.slug, undefined, { numeric: true });
}

const entries = await readdir(MARKDOWN_DIR);
const files = entries.filter((name) => name.toLowerCase().endsWith(".md"));

const cards = await Promise.all(
    files.map(async (name) => {
        const slug = name.replace(/\.md$/i, "");
        const source = await readFile(join(MARKDOWN_DIR, name), "utf8");
        return { slug, title: extractTitle(source, slug) };
    })
);

cards.sort(compareSlugs);

await writeFile(OUTPUT, JSON.stringify({ cards }) + "\n", "utf8");

console.log(`manifest.json written — ${cards.length} card(s)`);

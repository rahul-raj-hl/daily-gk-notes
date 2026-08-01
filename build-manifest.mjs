#!/usr/bin/env node
// Scans the markdown folder and writes a manifest the browser reads on load,
// so the app never has to discover files by probing the network.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MARKDOWN_DIR = join(ROOT, "markdowns");
const OUTPUT = join(MARKDOWN_DIR, "manifest.json");

// Handles the flat `key: value` and `- item` list shapes used in card
// frontmatter. Not a general YAML parser.
function parseFrontMatter(source) {
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};

    const meta = {};
    let listKey = null;

    for (const raw of match[1].split(/\r?\n/)) {
        const item = raw.match(/^\s*-\s+(.*)$/);
        if (item && listKey) {
            meta[listKey].push(item[1].trim());
            continue;
        }

        const pair = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!pair) continue;

        const key = pair[1];
        const value = pair[2].trim();
        if (value === "") {
            listKey = key;
            meta[key] = [];
        } else {
            listKey = null;
            meta[key] = value.replace(/^["']|["']$/g, "");
        }
    }

    return meta;
}

function extractTitle(source, meta, fallback) {
    if (typeof meta.title === "string" && meta.title) return meta.title;
    const match = source.match(/^#\s+(.+)$/m);
    return match ? match[1].replace(/\s+/g, " ").trim() : fallback;
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
        const meta = parseFrontMatter(source);

        // Only fields needed for search and future subject filters go in the
        // manifest; the rest is read from the card itself when it is opened.
        const card = { slug, title: extractTitle(source, meta, slug) };
        if (meta.subject) card.subject = meta.subject;
        if (meta.topic) card.topic = meta.topic;
        return card;
    })
);

cards.sort(compareSlugs);

const subjects = [...new Set(cards.map((c) => c.subject).filter(Boolean))].sort();

await writeFile(OUTPUT, JSON.stringify({ subjects, cards }) + "\n", "utf8");

console.log(
    `manifest.json written — ${cards.length} card(s)` +
        (subjects.length ? `, ${subjects.length} subject(s): ${subjects.join(", ")}` : "")
);

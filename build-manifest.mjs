#!/usr/bin/env node
// Scans the markdown folder and writes a manifest the browser reads on load,
// so the app never has to discover files by probing the network.
//
// Cards live in per-set subfolders (markdowns/test-1/1.md), and a card's slug
// is its path below markdowns/ without the extension: "test-1/1".

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

async function collectMarkdown(dir, prefix = "") {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = [];

    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;

        if (entry.isDirectory()) {
            found.push(...(await collectMarkdown(join(dir, entry.name), prefix + entry.name + "/")));
        } else if (entry.name.toLowerCase().endsWith(".md")) {
            found.push({ path: join(dir, entry.name), slug: prefix + entry.name.replace(/\.md$/i, "") });
        }
    }

    return found;
}

// Group by folder, then order numerically inside it so 2 precedes 10.
function compareCards(a, b) {
    const cut = (slug) => {
        const at = slug.lastIndexOf("/");
        return at === -1 ? ["", slug] : [slug.slice(0, at), slug.slice(at + 1)];
    };
    const [aDir, aName] = cut(a.slug);
    const [bDir, bName] = cut(b.slug);
    const collate = { numeric: true, sensitivity: "base" };

    if (aDir !== bDir) return aDir.localeCompare(bDir, undefined, collate);
    return aName.localeCompare(bName, undefined, collate);
}

const files = await collectMarkdown(MARKDOWN_DIR);
const skipped = [];

const parsed = await Promise.all(
    files.map(async (file) => {
        const source = await readFile(file.path, "utf8");
        if (source.trim() === "") {
            skipped.push(file.slug);
            return null;
        }

        const meta = parseFrontMatter(source);

        // Only fields needed for search and future subject filters go in the
        // manifest; the rest is read from the card itself when it is opened.
        const card = { slug: file.slug, title: extractTitle(source, meta, file.slug) };
        if (meta.subject) card.subject = meta.subject;
        if (meta.topic) card.topic = meta.topic;
        return card;
    })
);

const cards = parsed.filter(Boolean).sort(compareCards);
const subjects = [...new Set(cards.map((c) => c.subject).filter(Boolean))].sort();
const sets = [...new Set(cards.map((c) => (c.slug.includes("/") ? c.slug.split("/")[0] : "")).filter(Boolean))].sort();

await writeFile(OUTPUT, JSON.stringify({ sets, subjects, cards }) + "\n", "utf8");

console.log(
    `manifest.json written — ${cards.length} card(s)` +
        (sets.length ? `, ${sets.length} set(s): ${sets.join(", ")}` : "") +
        (subjects.length ? `, subjects: ${subjects.join(", ")}` : "")
);
if (skipped.length) console.log(`skipped ${skipped.length} empty file(s): ${skipped.join(", ")}`);

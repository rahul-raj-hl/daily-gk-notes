(function () {
    "use strict";

    var MARKDOWN_DIR = "markdowns";
    var MANIFEST_URL = MARKDOWN_DIR + "/manifest.json";
    var MAX_RESULTS = 40;
    var CACHE_LIMIT = 60;
    var LAST_CARD_KEY = "ssc-gs-last-card";
    var REVISION_KEY = "ssc-gs-revision-";
    var REVISION_SIZE = 25;
    var SCORE_CORRECT = 2;
    var SCORE_WRONG = -0.5;

    var contentEl = document.getElementById("content");
    var counterEl = document.getElementById("counter");
    var progressEl = document.getElementById("progress-bar");
    var prevBtn = document.getElementById("prev-btn");
    var nextBtn = document.getElementById("next-btn");
    var themeToggle = document.getElementById("theme-toggle");
    var searchBtn = document.getElementById("search-btn");
    var revisionBtn = document.getElementById("revision-btn");
    var pagerEl = document.querySelector(".pager");
    var overlayEl = document.getElementById("search-overlay");
    var searchInput = document.getElementById("search-input");
    var resultsEl = document.getElementById("search-results");

    var cards = [];
    var current = 0;
    var renderToken = 0;
    var results = [];
    var activeResult = 0;
    var mode = "card";
    var revision = null;

    var folderFilterEl = document.getElementById("folder-filter");
    var FOLDER_KEY = "ssc-gs-active-folder";
    var activeFolder = "all";

    // Parsed cards are kept in memory so revisiting one is instant, but bounded
    // so a long session over thousands of cards cannot grow without limit.
    var cache = new Map();

    function getCardSet(card) {
        if (!card || !card.slug) return "";
        var at = card.slug.indexOf("/");
        return at === -1 ? "" : card.slug.slice(0, at);
    }

    function getFilteredIndices() {
        var indices = [];
        for (var i = 0; i < cards.length; i++) {
            if (activeFolder === "all" || getCardSet(cards[i]) === activeFolder) {
                indices.push(i);
            }
        }
        return indices;
    }

    function populateFolderFilter(sets) {
        if (!folderFilterEl) return;
        folderFilterEl.innerHTML = "";

        var counts = {};
        cards.forEach(function (card) {
            var s = getCardSet(card);
            if (s) counts[s] = (counts[s] || 0) + 1;
        });

        var allOpt = document.createElement("option");
        allOpt.value = "all";
        allOpt.textContent = "📁 All Folders (" + cards.length + ")";
        folderFilterEl.appendChild(allOpt);

        var availableSets = sets && sets.length ? sets.slice() : Object.keys(counts).sort();
        availableSets.forEach(function (set) {
            var opt = document.createElement("option");
            opt.value = set;
            var label = set.trim();
            opt.textContent = "📂 " + label + " (" + (counts[set] || 0) + ")";
            folderFilterEl.appendChild(opt);
        });

        var savedFolder = readSavedFolder();
        if (savedFolder && (savedFolder === "all" || availableSets.indexOf(savedFolder) !== -1)) {
            activeFolder = savedFolder;
            folderFilterEl.value = activeFolder;
        } else {
            activeFolder = "all";
            folderFilterEl.value = "all";
        }
    }

    function readSavedFolder() {
        try {
            return localStorage.getItem(FOLDER_KEY) || "all";
        } catch (err) {
            return "all";
        }
    }

    function rememberFolder(folder) {
        try {
            localStorage.setItem(FOLDER_KEY, folder);
        } catch (err) {}
    }

    marked.setOptions({ gfm: true, breaks: false });

    function inline(text) {
        return marked.parseInline(text);
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = text == null ? "" : text;
        return div.innerHTML;
    }

    /* ---------- Parsing ---------- */

    // Handles the flat `key: value` and `- item` list shapes used in card
    // frontmatter. Not a general YAML parser.
    function parseFrontMatter(source) {
        var match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        if (!match) return { meta: {}, body: source };

        var meta = {};
        var listKey = null;

        match[1].split(/\r?\n/).forEach(function (raw) {
            var item = raw.match(/^\s*-\s+(.*)$/);
            if (item && listKey) {
                meta[listKey].push(item[1].trim());
                return;
            }

            var pair = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
            if (!pair) return;

            var value = pair[2].trim();
            if (value === "") {
                listKey = pair[1];
                meta[listKey] = [];
            } else {
                listKey = null;
                meta[pair[1]] = value.replace(/^["']|["']$/g, "");
            }
        });

        return { meta: meta, body: source.slice(match[0].length) };
    }

    // Practice questions are pulled out of the prose so they can be rendered as
    // an interactive quiz rather than a list of checkboxes with visible answers.
    function splitQuiz(body) {
        var heading = body.match(/^#{2,3}[^\n]*Practice Questions[^\n]*$/im);
        if (!heading) return { content: body, questions: [] };

        var at = body.indexOf(heading[0]);
        return {
            content: body.slice(0, at),
            questions: parseQuestions(body.slice(at + heading[0].length))
        };
    }

    function parseQuestions(raw) {
        return raw
            .split(/^#{3,4}\s+/m)
            .slice(1)
            .map(function (block) {
                var lines = block.split(/\r?\n/);
                var label = (lines.shift() || "").trim();
                var prompt = [];
                var options = [];
                var explanation = [];

                lines.forEach(function (line) {
                    var option = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
                    if (option) {
                        options.push({ text: option[2].trim(), correct: option[1].toLowerCase() === "x" });
                        return;
                    }

                    var note = line.match(/^\s*>\s?(.*)$/);
                    if (note) {
                        explanation.push(note[1].replace(/^\**Explanation:?\**\s*/i, ""));
                        return;
                    }

                    if (/^\s*-{3,}\s*$/.test(line)) return;
                    if (options.length === 0) prompt.push(line);
                });

                return {
                    label: label,
                    prompt: prompt.join("\n").trim(),
                    options: options,
                    explanation: explanation.join("\n").trim()
                };
            })
            .filter(function (q) {
                return q.options.length > 0;
            });
    }

    /* ---------- Rendering ---------- */

    function buildMeta(meta) {
        var chips = [];
        if (meta.subject) chips.push({ text: meta.subject, cls: "chip-subject" });
        if (meta.topic) chips.push({ text: meta.topic, cls: "" });
        if (meta.difficulty) chips.push({ text: meta.difficulty, cls: "chip-" + slugify(meta.difficulty) });
        if (meta.yield) chips.push({ text: meta.yield + " yield", cls: "chip-yield-" + slugify(meta.yield) });

        var tags = Array.isArray(meta.tags) ? meta.tags : [];
        if (!chips.length && !tags.length) return null;

        var wrap = document.createElement("div");
        wrap.className = "meta";

        chips.forEach(function (chip) {
            var el = document.createElement("span");
            el.className = "chip " + chip.cls;
            el.textContent = chip.text;
            wrap.appendChild(el);
        });

        tags.forEach(function (tag) {
            var el = document.createElement("span");
            el.className = "tag";
            el.textContent = "#" + tag;
            wrap.appendChild(el);
        });

        return wrap;
    }

    function slugify(value) {
        return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    }

    function buildQuiz(questions) {
        var section = document.createElement("section");
        section.className = "quiz";

        var head = document.createElement("div");
        head.className = "quiz-head";
        head.innerHTML =
            '<h2 class="quiz-title">📝 Practice Questions</h2><span class="quiz-score">0 / ' +
            questions.length +
            " answered</span>";
        section.appendChild(head);

        var scoreEl = head.querySelector(".quiz-score");
        var answered = 0;
        var correct = 0;

        questions.forEach(function (question, qi) {
            var block = document.createElement("div");
            block.className = "quiz-q";

            var prompt = document.createElement("p");
            prompt.className = "quiz-prompt";
            prompt.innerHTML =
                '<span class="quiz-label">' + (question.label || "Q" + (qi + 1)) + "</span>" + inline(question.prompt);
            block.appendChild(prompt);

            var list = document.createElement("div");
            list.className = "quiz-options";

            var explanationEl = document.createElement("div");
            explanationEl.className = "quiz-explanation";
            explanationEl.hidden = true;
            if (question.explanation) explanationEl.innerHTML = marked.parse(question.explanation);

            question.options.forEach(function (option) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "quiz-option";
                btn.innerHTML = inline(option.text);

                btn.addEventListener("click", function () {
                    if (block.classList.contains("is-answered")) return;
                    block.classList.add("is-answered");

                    Array.prototype.forEach.call(list.children, function (child, i) {
                        child.disabled = true;
                        if (question.options[i].correct) child.classList.add("is-correct");
                    });
                    if (!option.correct) btn.classList.add("is-wrong");

                    if (question.explanation) explanationEl.hidden = false;

                    answered++;
                    if (option.correct) correct++;
                    scoreEl.textContent = answered + " / " + questions.length + " answered · " + correct + " correct";
                });

                list.appendChild(btn);
            });

            block.appendChild(list);
            block.appendChild(explanationEl);
            section.appendChild(block);
        });

        return section;
    }

    /* ---------- Loading ---------- */

    function cacheGet(slug) {
        if (!cache.has(slug)) return null;
        var value = cache.get(slug);
        cache.delete(slug);
        cache.set(slug, value);
        return value;
    }

    function cacheSet(slug, value) {
        cache.set(slug, value);
        if (cache.size > CACHE_LIMIT) {
            cache.delete(cache.keys().next().value);
        }
    }

    function loadCard(index) {
        var card = cards[index];
        if (!card) return Promise.resolve(null);

        var cached = cacheGet(card.slug);
        if (cached !== null) return Promise.resolve(cached);

        return fetch(MARKDOWN_DIR + "/" + card.slug + ".md", { cache: "no-cache" })
            .then(function (res) {
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.text();
            })
            .then(function (source) {
                var parsed = parseFrontMatter(source);
                var split = splitQuiz(parsed.body);
                var value = {
                    meta: parsed.meta,
                    contentHtml: marked.parse(split.content),
                    questions: split.questions
                };
                cacheSet(card.slug, value);
                return value;
            });
    }

    function render() {
        var visibleIndices = getFilteredIndices();
        if (visibleIndices.length === 0) {
            contentEl.innerHTML = '<p class="status">No cards found in this test folder.</p>';
            counterEl.textContent = "0 / 0";
            progressEl.style.width = "0%";
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            return;
        }

        var pos = visibleIndices.indexOf(current);
        if (pos === -1) {
            current = visibleIndices[0];
            pos = 0;
        }

        var card = cards[current];
        var token = ++renderToken;

        var totalVisible = visibleIndices.length;
        counterEl.textContent = pos + 1 + " / " + totalVisible;
        progressEl.style.width = ((pos + 1) / totalVisible) * 100 + "%";
        prevBtn.disabled = pos === 0;
        nextBtn.disabled = pos === totalVisible - 1;

        if (window.location.hash !== "#" + card.slug) {
            history.replaceState(null, "", "#" + card.slug);
        }
        rememberCard(card.slug);
        document.title = card.title + " · SSC GS";

        loadCard(current)
            .then(function (data) {
                if (token !== renderToken) return;

                contentEl.innerHTML = "";

                var meta = buildMeta(data.meta);
                if (meta) contentEl.appendChild(meta);

                var prose = document.createElement("div");
                prose.className = "prose";
                prose.innerHTML = data.contentHtml;
                contentEl.appendChild(prose);

                if (data.questions.length) contentEl.appendChild(buildQuiz(data.questions));

                window.scrollTo({ top: 0, behavior: "smooth" });
                prefetchNeighbours();
            })
            .catch(function (err) {
                if (token !== renderToken) return;
                contentEl.innerHTML =
                    '<p class="status status-error">Could not load <code>' +
                    card.slug +
                    ".md</code> — " +
                    err.message +
                    "</p>";
            });
    }

    function prefetchNeighbours() {
        var visibleIndices = getFilteredIndices();
        var pos = visibleIndices.indexOf(current);
        if (pos === -1) return;

        [pos + 1, pos - 1].forEach(function (p) {
            if (p >= 0 && p < visibleIndices.length) {
                loadCard(visibleIndices[p]).catch(function () {});
            }
        });
    }

    function go(index) {
        if (mode === "revision") return;
        if (index < 0 || index >= cards.length || index === current) return;
        current = index;

        var cardSet = getCardSet(cards[current]);
        if (activeFolder !== "all" && cardSet !== activeFolder) {
            activeFolder = cardSet || "all";
            rememberFolder(activeFolder);
            if (folderFilterEl) folderFilterEl.value = activeFolder;
        }

        render();
    }

    function indexOfSlug(slug) {
        if (!slug) return -1;
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].slug === slug) return i;
        }
        return -1;
    }

    function indexFromHash() {
        var found = indexOfSlug(decodeURIComponent(window.location.hash.replace("#", "")));
        return found === -1 ? 0 : found;
    }

    // A shared link's hash wins; otherwise pick up where the last visit ended.
    // A saved slug can go stale if that card was renamed or removed.
    function startingIndex() {
        var fromHash = indexOfSlug(decodeURIComponent(window.location.hash.replace("#", "")));
        if (fromHash !== -1) return fromHash;

        var saved = indexOfSlug(readLastSlug());
        return saved === -1 ? 0 : saved;
    }

    function readLastSlug() {
        try {
            return localStorage.getItem(LAST_CARD_KEY);
        } catch (err) {
            return null;
        }
    }

    function rememberCard(slug) {
        try {
            localStorage.setItem(LAST_CARD_KEY, slug);
        } catch (err) {
            /* private browsing or full storage — position simply is not kept */
        }
    }

    /* ---------- Search ---------- */

    function openSearch() {
        overlayEl.hidden = false;
        searchInput.value = "";
        runSearch("");
        searchInput.focus();
    }

    function closeSearch() {
        overlayEl.hidden = true;
        searchInput.blur();
    }

    function haystack(card) {
        return (
            card.title +
            " " +
            (card.subject || "") +
            " " +
            (card.topic || "") +
            " " +
            card.slug
        ).toLowerCase();
    }

    // Slugs are set-qualified ("test-5/3"), so a bare number has to be matched
    // against the file name for "type a card number" to keep working.
    function cardNumber(slug) {
        var at = slug.lastIndexOf("/");
        return at === -1 ? slug : slug.slice(at + 1);
    }

    function runSearch(query) {
        var q = query.trim().toLowerCase();
        var matches = [];

        for (var i = 0; i < cards.length && matches.length < MAX_RESULTS; i++) {
            if (activeFolder !== "all" && getCardSet(cards[i]) !== activeFolder) continue;
            if (q === "" || haystack(cards[i]).indexOf(q) !== -1 || cardNumber(cards[i].slug).indexOf(q) === 0) {
                matches.push(i);
            }
        }

        results = matches;
        activeResult = 0;
        paintResults();
    }

    function paintResults() {
        resultsEl.innerHTML = "";

        if (!results.length) {
            var empty = document.createElement("li");
            empty.className = "search-empty";
            empty.textContent = activeFolder !== "all" ? "No matching cards in folder '" + activeFolder.trim() + "'" : "No matching cards";
            resultsEl.appendChild(empty);
            return;
        }

        results.forEach(function (cardIndex, i) {
            var card = cards[cardIndex];
            var li = document.createElement("li");
            li.className = "search-result" + (i === activeResult ? " is-active" : "");

            var num = document.createElement("span");
            num.className = "search-num";
            num.textContent = cardIndex + 1;

            var title = document.createElement("span");
            title.className = "search-title";
            title.textContent = card.title;

            li.appendChild(num);
            li.appendChild(title);

            if (card.subject) {
                var subject = document.createElement("span");
                subject.className = "search-subject";
                subject.textContent = card.subject;
                li.appendChild(subject);
            }

            var cardSet = getCardSet(card);
            if (cardSet) {
                var setBadge = document.createElement("span");
                setBadge.className = "search-set";
                setBadge.textContent = cardSet.trim();
                li.appendChild(setBadge);
            }

            li.addEventListener("click", function () {
                closeSearch();
                go(cardIndex);
            });
            resultsEl.appendChild(li);
        });
    }

    function moveResult(delta) {
        if (!results.length) return;
        activeResult = (activeResult + delta + results.length) % results.length;
        paintResults();
        var active = resultsEl.querySelector(".is-active");
        if (active) active.scrollIntoView({ block: "nearest" });
    }

    /* ---------- Quick revision ---------- */

    function todayKey() {
        var now = new Date();
        return (
            now.getFullYear() +
            "-" +
            String(now.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(now.getDate()).padStart(2, "0")
        );
    }

    function hashString(text) {
        var h = 2166136261;
        for (var i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    // Seeded so everyone opening the app on the same day gets the same paper,
    // and reloading mid-attempt does not reshuffle the questions.
    function seededRandom(seed) {
        var a = seed;
        return function () {
            a = (a + 0x6d2b79f5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function shuffle(list, rng) {
        for (var i = list.length - 1; i > 0; i--) {
            var j = Math.floor(rng() * (i + 1));
            var tmp = list[i];
            list[i] = list[j];
            list[j] = tmp;
        }
        return list;
    }

    // Round-robin across subjects so a subject with many cards cannot crowd out
    // the rest of the paper.
    function pickDailyCards(rng) {
        var pool = cards.filter(function (card) {
            return card.q > 0;
        });

        var bySubject = {};
        pool.forEach(function (card) {
            var key = card.subject || "Other";
            if (!bySubject[key]) bySubject[key] = [];
            bySubject[key].push(card);
        });

        var subjects = shuffle(Object.keys(bySubject), rng);
        subjects.forEach(function (key) {
            shuffle(bySubject[key], rng);
        });

        var ordered = [];
        for (var depth = 0; ordered.length < pool.length; depth++) {
            var addedAny = false;
            for (var s = 0; s < subjects.length; s++) {
                var group = bySubject[subjects[s]];
                if (group.length > depth) {
                    ordered.push(group[depth]);
                    addedAny = true;
                }
            }
            if (!addedAny) break;
        }

        return ordered;
    }

    function buildDailyPaper() {
        var dateKey = todayKey();
        var rng = seededRandom(hashString(dateKey));
        var ordered = pickDailyCards(rng);

        if (!ordered.length) return Promise.resolve({ dateKey: dateKey, questions: [] });

        // Only the cards that can contribute are fetched, never the whole set.
        var needed = ordered.slice(0, REVISION_SIZE);
        var extras = ordered.slice(REVISION_SIZE, REVISION_SIZE * 2);

        return Promise.all(
            needed.concat(extras).map(function (card) {
                return loadBySlug(card.slug)
                    .then(function (data) {
                        return { card: card, questions: shuffle(data.questions.slice(), rng) };
                    })
                    .catch(function () {
                        return null;
                    });
            })
        ).then(function (loaded) {
            var usable = loaded.filter(function (entry) {
                return entry && entry.questions.length;
            });

            // First one question per card for maximum topic spread, then a
            // second from each until the paper is full.
            var paper = [];
            for (var depth = 0; paper.length < REVISION_SIZE; depth++) {
                var addedAny = false;
                for (var i = 0; i < usable.length && paper.length < REVISION_SIZE; i++) {
                    var entry = usable[i];
                    if (entry.questions.length > depth) {
                        paper.push({
                            slug: entry.card.slug,
                            title: entry.card.title,
                            subject: entry.card.subject || "",
                            question: entry.questions[depth]
                        });
                        addedAny = true;
                    }
                }
                if (!addedAny) break;
            }

            return { dateKey: dateKey, questions: paper };
        });
    }

    function loadBySlug(slug) {
        var index = indexOfSlug(slug);
        if (index === -1) return Promise.reject(new Error("unknown card"));
        return loadCard(index);
    }

    function revisionSignature(paper) {
        return paper.dateKey + ":" + paper.questions.length;
    }

    function readAttempt(paper) {
        try {
            var raw = localStorage.getItem(REVISION_KEY + paper.dateKey);
            if (!raw) return null;
            var saved = JSON.parse(raw);
            if (saved.sig !== revisionSignature(paper)) return null;
            return saved;
        } catch (err) {
            return null;
        }
    }

    function saveAttempt() {
        try {
            localStorage.setItem(
                REVISION_KEY + revision.dateKey,
                JSON.stringify({ sig: revisionSignature(revision), answers: revision.answers, done: revision.done })
            );
        } catch (err) {
            /* storage unavailable — the attempt just will not survive a reload */
        }
    }

    function scoreOf(answers, questions) {
        var correct = 0;
        var wrong = 0;
        var skipped = 0;

        answers.forEach(function (answer, i) {
            if (answer === null || answer === undefined) return;
            if (answer === "skip") {
                skipped++;
            } else if (questions[i].question.options[answer] && questions[i].question.options[answer].correct) {
                correct++;
            } else {
                wrong++;
            }
        });

        return {
            correct: correct,
            wrong: wrong,
            skipped: skipped,
            answered: correct + wrong,
            points: correct * SCORE_CORRECT + wrong * SCORE_WRONG
        };
    }

    function formatPoints(value) {
        return String(Math.round(value * 10) / 10);
    }

    function enterRevision() {
        mode = "revision";
        pagerEl.hidden = true;
        progressEl.style.width = "0%";
        counterEl.textContent = "";
        document.title = "Quick Revision · SSC GS";
        if (window.location.hash !== "#revision") history.replaceState(null, "", "#revision");

        contentEl.innerHTML = '<p class="status">Building today\'s paper…</p>';

        buildDailyPaper()
            .then(function (paper) {
                if (mode !== "revision") return;

                if (!paper.questions.length) {
                    contentEl.innerHTML =
                        '<p class="status">No practice questions found yet. Add a ' +
                        "<code>Practice Questions</code> section to a card and rebuild.</p>" +
                        '<p class="status"><button class="nav-btn" id="rev-exit">Back to cards</button></p>';
                    document.getElementById("rev-exit").addEventListener("click", exitRevision);
                    return;
                }

                var saved = readAttempt(paper);
                revision = {
                    dateKey: paper.dateKey,
                    questions: paper.questions,
                    answers: saved ? saved.answers : paper.questions.map(function () {
                        return null;
                    }),
                    done: saved ? saved.done : false
                };

                revision.index = revision.answers.findIndex(function (a) {
                    return a === null || a === undefined;
                });
                if (revision.index === -1) revision.index = revision.questions.length - 1;

                if (revision.done) renderResults();
                else renderRevisionQuestion();
            })
            .catch(function (err) {
                contentEl.innerHTML = '<p class="status status-error">Could not build the paper — ' + err.message + "</p>";
            });
    }

    function exitRevision() {
        mode = "card";
        pagerEl.hidden = false;
        revision = null;
        if (window.location.hash === "#revision") history.replaceState(null, "", "#" + cards[current].slug);
        render();
    }

    function renderRevisionQuestion() {
        var item = revision.questions[revision.index];
        var question = item.question;
        var total = revision.questions.length;
        var tally = scoreOf(revision.answers, revision.questions);
        var chosen = revision.answers[revision.index];

        progressEl.style.width = ((revision.index + 1) / total) * 100 + "%";

        contentEl.innerHTML = "";

        var head = document.createElement("div");
        head.className = "rev-head";
        head.innerHTML =
            '<div><h2 class="rev-title">⚡ Quick Revision</h2>' +
            '<p class="rev-date">' +
            revision.dateKey +
            " · +" +
            SCORE_CORRECT +
            " correct, " +
            SCORE_WRONG +
            " wrong</p></div>" +
            '<div class="rev-stats"><span class="rev-count">' +
            (revision.index + 1) +
            " / " +
            total +
            '</span><span class="rev-points">' +
            formatPoints(tally.points) +
            " pts</span></div>";
        contentEl.appendChild(head);

        var block = document.createElement("div");
        block.className = "rev-question";

        var meta = document.createElement("div");
        meta.className = "rev-meta";
        meta.innerHTML =
            (item.subject ? '<span class="chip chip-subject">' + escapeHtml(item.subject) + "</span>" : "") +
            '<span class="rev-source">' +
            escapeHtml(item.title) +
            "</span>";
        block.appendChild(meta);

        var prompt = document.createElement("p");
        prompt.className = "rev-prompt";
        prompt.innerHTML = inline(question.prompt);
        block.appendChild(prompt);

        var list = document.createElement("div");
        list.className = "quiz-options";

        var explanation = document.createElement("div");
        explanation.className = "quiz-explanation";
        explanation.hidden = true;
        if (question.explanation) explanation.innerHTML = marked.parse(question.explanation);

        var footer = document.createElement("div");
        footer.className = "rev-actions";

        question.options.forEach(function (option, optionIndex) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "quiz-option";
            btn.innerHTML = inline(option.text);
            btn.addEventListener("click", function () {
                if (revision.answers[revision.index] !== null) return;
                revision.answers[revision.index] = optionIndex;
                saveAttempt();
                renderRevisionQuestion();
            });
            list.appendChild(btn);
        });

        block.appendChild(list);
        block.appendChild(explanation);

        var answered = chosen !== null && chosen !== undefined;
        if (answered) {
            Array.prototype.forEach.call(list.children, function (child, i) {
                child.disabled = true;
                if (question.options[i].correct) child.classList.add("is-correct");
            });
            if (chosen !== "skip" && !question.options[chosen].correct) {
                list.children[chosen].classList.add("is-wrong");
            }
            if (chosen === "skip") block.classList.add("is-skipped");
            if (question.explanation) explanation.hidden = false;
        }

        if (!answered) {
            var skip = document.createElement("button");
            skip.type = "button";
            skip.className = "nav-btn";
            skip.textContent = "Skip";
            skip.addEventListener("click", function () {
                revision.answers[revision.index] = "skip";
                saveAttempt();
                renderRevisionQuestion();
            });
            footer.appendChild(skip);
        } else {
            var next = document.createElement("button");
            next.type = "button";
            next.className = "nav-btn nav-btn-primary";
            var isLast = revision.index === total - 1;
            next.textContent = isLast ? "See results" : "Next question →";
            next.addEventListener("click", function () {
                if (isLast) {
                    revision.done = true;
                    saveAttempt();
                    renderResults();
                } else {
                    revision.index++;
                    renderRevisionQuestion();
                }
            });
            footer.appendChild(next);
        }

        var quit = document.createElement("button");
        quit.type = "button";
        quit.className = "nav-btn rev-quit";
        quit.textContent = "Exit";
        quit.addEventListener("click", exitRevision);
        footer.appendChild(quit);

        block.appendChild(footer);
        contentEl.appendChild(block);
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function renderResults() {
        var total = revision.questions.length;
        var tally = scoreOf(revision.answers, revision.questions);
        var max = total * SCORE_CORRECT;

        progressEl.style.width = "100%";
        contentEl.innerHTML = "";

        var head = document.createElement("div");
        head.className = "rev-result-head";
        head.innerHTML =
            '<p class="rev-date">Quick Revision · ' +
            revision.dateKey +
            '</p><p class="rev-final">' +
            formatPoints(tally.points) +
            ' <span class="rev-final-max">/ ' +
            max +
            "</span></p>";
        contentEl.appendChild(head);

        var stats = document.createElement("div");
        stats.className = "rev-summary";
        [
            { label: "Correct", value: tally.correct, cls: "is-correct" },
            { label: "Wrong", value: tally.wrong, cls: "is-wrong" },
            { label: "Skipped", value: tally.skipped, cls: "" },
            {
                label: "Accuracy",
                value: tally.answered ? Math.round((tally.correct / tally.answered) * 100) + "%" : "—",
                cls: ""
            }
        ].forEach(function (stat) {
            var box = document.createElement("div");
            box.className = "rev-stat " + stat.cls;
            box.innerHTML = '<span class="rev-stat-value">' + stat.value + '</span><span class="rev-stat-label">' + stat.label + "</span>";
            stats.appendChild(box);
        });
        contentEl.appendChild(stats);

        var review = document.createElement("ol");
        review.className = "rev-review";

        revision.questions.forEach(function (item, i) {
            var answer = revision.answers[i];
            var correctOption = item.question.options.find(function (o) {
                return o.correct;
            });
            var state = answer === "skip" || answer === null ? "skipped" : item.question.options[answer].correct ? "correct" : "wrong";

            var li = document.createElement("li");
            li.className = "rev-review-item is-" + state;

            var prompt = document.createElement("p");
            prompt.className = "rev-review-prompt";
            prompt.innerHTML = inline(item.question.prompt);
            li.appendChild(prompt);

            var detail = document.createElement("p");
            detail.className = "rev-review-detail";
            if (state === "wrong") {
                detail.innerHTML =
                    '<span class="rev-yours">You: ' +
                    inline(item.question.options[answer].text) +
                    '</span><span class="rev-right">Answer: ' +
                    inline(correctOption ? correctOption.text : "—") +
                    "</span>";
            } else if (state === "skipped") {
                detail.innerHTML = '<span class="rev-right">Answer: ' + inline(correctOption ? correctOption.text : "—") + "</span>";
            } else {
                detail.innerHTML = '<span class="rev-right">Answer: ' + inline(correctOption.text) + "</span>";
            }
            li.appendChild(detail);

            var link = document.createElement("button");
            link.type = "button";
            link.className = "rev-jump";
            link.textContent = "Open " + item.title;
            link.addEventListener("click", function () {
                var target = indexOfSlug(item.slug);
                mode = "card";
                pagerEl.hidden = false;
                revision = null;
                current = target === -1 ? current : target;
                render();
            });
            li.appendChild(link);

            review.appendChild(li);
        });

        contentEl.appendChild(review);

        var actions = document.createElement("div");
        actions.className = "rev-actions";

        var retry = document.createElement("button");
        retry.type = "button";
        retry.className = "nav-btn";
        retry.textContent = "Retry today's paper";
        retry.addEventListener("click", function () {
            revision.answers = revision.questions.map(function () {
                return null;
            });
            revision.index = 0;
            revision.done = false;
            saveAttempt();
            renderRevisionQuestion();
        });
        actions.appendChild(retry);

        var back = document.createElement("button");
        back.type = "button";
        back.className = "nav-btn nav-btn-primary";
        back.textContent = "Back to cards";
        back.addEventListener("click", exitRevision);
        actions.appendChild(back);

        contentEl.appendChild(actions);
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    /* ---------- Setup ---------- */

    function showError(message) {
        contentEl.innerHTML = '<p class="status status-error">' + message + "</p>";
        counterEl.textContent = "0 / 0";
        prevBtn.disabled = true;
        nextBtn.disabled = true;
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
        localStorage.setItem("ssc-gs-theme", theme);
    }

    prevBtn.addEventListener("click", function () {
        var visible = getFilteredIndices();
        var pos = visible.indexOf(current);
        if (pos > 0) {
            go(visible[pos - 1]);
        }
    });

    nextBtn.addEventListener("click", function () {
        var visible = getFilteredIndices();
        var pos = visible.indexOf(current);
        if (pos >= 0 && pos < visible.length - 1) {
            go(visible[pos + 1]);
        }
    });

    if (folderFilterEl) {
        folderFilterEl.addEventListener("change", function () {
            activeFolder = folderFilterEl.value;
            rememberFolder(activeFolder);
            var visible = getFilteredIndices();
            if (visible.length > 0) {
                if (visible.indexOf(current) === -1) {
                    current = visible[0];
                }
                render();
            }
        });
    }

    searchBtn.addEventListener("click", openSearch);

    revisionBtn.addEventListener("click", function () {
        if (mode === "revision") exitRevision();
        else enterRevision();
    });

    overlayEl.addEventListener("click", function (event) {
        if (event.target === overlayEl) closeSearch();
    });

    searchInput.addEventListener("input", function () {
        runSearch(searchInput.value);
    });

    searchInput.addEventListener("keydown", function (event) {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            moveResult(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveResult(-1);
        } else if (event.key === "Enter" && results.length) {
            event.preventDefault();
            var target = results[activeResult];
            closeSearch();
            go(target);
        } else if (event.key === "Escape") {
            closeSearch();
        }
    });

    themeToggle.addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(next);
    });

    document.addEventListener("keydown", function (event) {
        if (!overlayEl.hidden) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.target.tagName === "INPUT" || event.target.tagName === "BUTTON" || event.target.tagName === "SELECT") return;

        if (event.key === "/") {
            event.preventDefault();
            openSearch();
            return;
        }

        // Card paging would fight the revision flow, so it is suspended there.
        if (mode === "revision") {
            if (event.key === "Escape") exitRevision();
            return;
        }

        var visible = getFilteredIndices();
        var pos = visible.indexOf(current);

        if (event.key === "ArrowRight" || event.key === "PageDown") {
            if (pos >= 0 && pos < visible.length - 1) go(visible[pos + 1]);
        } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
            if (pos > 0) go(visible[pos - 1]);
        } else if (event.key === "Home") {
            if (visible.length) go(visible[0]);
        } else if (event.key === "End") {
            if (visible.length) go(visible[visible.length - 1]);
        }
    });

    window.addEventListener("hashchange", function () {
        if (!cards.length) return;
        if (window.location.hash === "#revision") {
            if (mode !== "revision") enterRevision();
            return;
        }
        if (mode === "revision") exitRevision();
        else go(indexFromHash());
    });

    applyTheme(localStorage.getItem("ssc-gs-theme") || "light");

    // Pages serves these with a 10-minute max-age, so revalidate on every load
    // or newly published cards stay invisible until the cached copy expires.
    fetch(MANIFEST_URL, { cache: "no-cache" })
        .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        })
        .then(function (data) {
            cards = data.cards || [];
            if (!cards.length) {
                showError("No cards listed in <code>" + MANIFEST_URL + "</code>.");
                return;
            }
            populateFolderFilter(data.sets);
            current = startingIndex();

            var startingSet = getCardSet(cards[current]);
            var savedFolder = readSavedFolder();
            if (window.location.hash && startingSet) {
                activeFolder = startingSet;
                rememberFolder(activeFolder);
                if (folderFilterEl) folderFilterEl.value = activeFolder;
            } else if (savedFolder && savedFolder !== "all") {
                var visible = getFilteredIndices();
                if (visible.indexOf(current) === -1 && visible.length > 0) {
                    current = visible[0];
                }
            }

            if (window.location.hash === "#revision") enterRevision();
            else render();
        })
        .catch(function () {
            if (window.location.protocol === "file:") {
                showError(
                    "Opening this page directly from disk blocks reading the markdown files. " +
                        "Serve the folder instead — run <code>python3 -m http.server 8000</code> here, " +
                        "then visit <code>http://localhost:8000</code>."
                );
            } else {
                showError(
                    "Could not read <code>" +
                        MANIFEST_URL +
                        "</code>. Generate it by running <code>npm run build</code> in the project folder."
                );
            }
        });
})();

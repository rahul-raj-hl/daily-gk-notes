(function () {
    "use strict";

    var MARKDOWN_DIR = "markdowns";
    var MANIFEST_URL = MARKDOWN_DIR + "/manifest.json";
    var MAX_RESULTS = 40;
    var CACHE_LIMIT = 60;
    var LAST_CARD_KEY = "ssc-gs-last-card";

    var contentEl = document.getElementById("content");
    var counterEl = document.getElementById("counter");
    var progressEl = document.getElementById("progress-bar");
    var prevBtn = document.getElementById("prev-btn");
    var nextBtn = document.getElementById("next-btn");
    var themeToggle = document.getElementById("theme-toggle");
    var searchBtn = document.getElementById("search-btn");
    var overlayEl = document.getElementById("search-overlay");
    var searchInput = document.getElementById("search-input");
    var resultsEl = document.getElementById("search-results");

    var cards = [];
    var current = 0;
    var renderToken = 0;
    var results = [];
    var activeResult = 0;

    // Parsed cards are kept in memory so revisiting one is instant, but bounded
    // so a long session over thousands of cards cannot grow without limit.
    var cache = new Map();

    marked.setOptions({ gfm: true, breaks: false });

    function inline(text) {
        return marked.parseInline(text);
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
        var card = cards[current];
        var token = ++renderToken;

        counterEl.textContent = current + 1 + " / " + cards.length;
        progressEl.style.width = ((current + 1) / cards.length) * 100 + "%";
        prevBtn.disabled = current === 0;
        nextBtn.disabled = current === cards.length - 1;

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
        [current + 1, current - 1].forEach(function (i) {
            if (i >= 0 && i < cards.length) loadCard(i).catch(function () {});
        });
    }

    function go(index) {
        if (index < 0 || index >= cards.length || index === current) return;
        current = index;
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
            empty.textContent = "No matching cards";
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
        go(current - 1);
    });

    nextBtn.addEventListener("click", function () {
        go(current + 1);
    });

    searchBtn.addEventListener("click", openSearch);

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
        if (event.target.tagName === "INPUT" || event.target.tagName === "BUTTON") return;

        if (event.key === "/") {
            event.preventDefault();
            openSearch();
        } else if (event.key === "ArrowRight" || event.key === "PageDown") {
            go(current + 1);
        } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
            go(current - 1);
        } else if (event.key === "Home") {
            go(0);
        } else if (event.key === "End") {
            go(cards.length - 1);
        }
    });

    window.addEventListener("hashchange", function () {
        if (cards.length) go(indexFromHash());
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
            current = startingIndex();
            render();
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

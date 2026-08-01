(function () {
    "use strict";

    var MARKDOWN_DIR = "markdowns";
    var MANIFEST_URL = MARKDOWN_DIR + "/manifest.json";
    var MAX_RESULTS = 40;
    var CACHE_LIMIT = 60;

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

    // Rendered markdown is kept in memory so revisiting a card is instant, but
    // bounded so a long session over thousands of cards cannot grow without limit.
    var cache = new Map();

    marked.setOptions({ gfm: true, breaks: false });

    function cacheGet(slug) {
        if (!cache.has(slug)) return null;
        var html = cache.get(slug);
        cache.delete(slug);
        cache.set(slug, html);
        return html;
    }

    function cacheSet(slug, html) {
        cache.set(slug, html);
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
                var html = marked.parse(source);
                cacheSet(card.slug, html);
                return html;
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
        document.title = card.title + " · SSC GS";

        loadCard(current)
            .then(function (html) {
                if (token !== renderToken) return;
                contentEl.innerHTML = html;
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

    function indexFromHash() {
        var slug = decodeURIComponent(window.location.hash.replace("#", ""));
        if (!slug) return 0;
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].slug === slug) return i;
        }
        return 0;
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

    function runSearch(query) {
        var q = query.trim().toLowerCase();
        var matches = [];

        for (var i = 0; i < cards.length && matches.length < MAX_RESULTS; i++) {
            if (q === "" || cards[i].title.toLowerCase().indexOf(q) !== -1 || cards[i].slug.indexOf(q) === 0) {
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
            var li = document.createElement("li");
            li.className = "search-result" + (i === activeResult ? " is-active" : "");
            li.innerHTML =
                '<span class="search-num">' + (cardIndex + 1) + "</span>" + escapeHtml(cards[cardIndex].title);
            li.addEventListener("click", function () {
                closeSearch();
                go(cardIndex);
            });
            resultsEl.appendChild(li);
        });
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
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
        if (event.target.tagName === "INPUT") return;

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
            current = indexFromHash();
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

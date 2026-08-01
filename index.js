(function () {
    "use strict";

    var MARKDOWN_DIR = "markdowns";
    var MAX_FILES = 500;
    var PROBE_CHUNK = 12;

    var contentEl = document.getElementById("content");
    var counterEl = document.getElementById("counter");
    var progressEl = document.getElementById("progress-bar");
    var prevBtn = document.getElementById("prev-btn");
    var nextBtn = document.getElementById("next-btn");
    var jumpSelect = document.getElementById("jump-select");
    var themeToggle = document.getElementById("theme-toggle");

    var cards = [];
    var current = 0;

    marked.setOptions({ gfm: true, breaks: false });

    function fileUrl(id) {
        return MARKDOWN_DIR + "/" + id + ".md";
    }

    function fetchCard(id) {
        return fetch(fileUrl(id), { cache: "no-cache" })
            .then(function (res) {
                if (!res.ok) return null;
                return res.text();
            })
            .then(function (text) {
                if (text === null) return null;
                return { id: id, source: text, title: extractTitle(text, id) };
            })
            .catch(function () {
                return null;
            });
    }

    function extractTitle(source, id) {
        var match = source.match(/^#\s+(.+)$/m);
        return match ? match[1].trim() : id + ".md";
    }

    // Files are numbered (1.md, 2.md, ...). Probe in chunks and keep going as
    // long as a chunk still yields hits, so small gaps in numbering are tolerated.
    function discoverCards() {
        var found = [];

        function probeFrom(start) {
            if (start > MAX_FILES) return Promise.resolve(found);

            var ids = [];
            for (var i = start; i < start + PROBE_CHUNK && i <= MAX_FILES; i++) {
                ids.push(i);
            }

            return Promise.all(ids.map(fetchCard)).then(function (results) {
                var hits = results.filter(Boolean);
                if (hits.length === 0) return found;
                found = found.concat(hits);
                return probeFrom(start + PROBE_CHUNK);
            });
        }

        return probeFrom(1).then(function (all) {
            all.sort(function (a, b) {
                return a.id - b.id;
            });
            return all;
        });
    }

    function render() {
        var card = cards[current];
        contentEl.innerHTML = marked.parse(card.source);
        window.scrollTo({ top: 0, behavior: "smooth" });

        counterEl.textContent = current + 1 + " / " + cards.length;
        progressEl.style.width = ((current + 1) / cards.length) * 100 + "%";
        prevBtn.disabled = current === 0;
        nextBtn.disabled = current === cards.length - 1;
        jumpSelect.value = String(current);

        if (window.location.hash !== "#" + card.id) {
            history.replaceState(null, "", "#" + card.id);
        }
        document.title = card.title + " · SSC GS";
    }

    function go(index) {
        if (index < 0 || index >= cards.length || index === current) return;
        current = index;
        render();
    }

    function indexFromHash() {
        var id = parseInt(window.location.hash.replace("#", ""), 10);
        if (isNaN(id)) return 0;
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].id === id) return i;
        }
        return 0;
    }

    function buildJumpList() {
        jumpSelect.innerHTML = "";
        cards.forEach(function (card, i) {
            var option = document.createElement("option");
            option.value = String(i);
            option.textContent = i + 1 + ". " + card.title;
            jumpSelect.appendChild(option);
        });
    }

    function showEmptyState() {
        var isFileProtocol = window.location.protocol === "file:";
        contentEl.innerHTML = isFileProtocol
            ? '<p class="status status-error">Opening this page directly from disk blocks reading the markdown files. ' +
              "Serve the folder instead — run <code>python3 -m http.server 8000</code> here, " +
              "then visit <code>http://localhost:8000</code>.</p>"
            : '<p class="status status-error">No markdown files found in <code>' +
              MARKDOWN_DIR +
              "/</code>. Add <code>1.md</code>, <code>2.md</code>, and so on.</p>";
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

    jumpSelect.addEventListener("change", function () {
        go(parseInt(jumpSelect.value, 10));
    });

    themeToggle.addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(next);
    });

    document.addEventListener("keydown", function (event) {
        if (event.target.tagName === "SELECT" || event.metaKey || event.ctrlKey) return;
        if (event.key === "ArrowRight" || event.key === "PageDown") go(current + 1);
        if (event.key === "ArrowLeft" || event.key === "PageUp") go(current - 1);
    });

    window.addEventListener("hashchange", function () {
        if (cards.length) go(indexFromHash());
    });

    applyTheme(localStorage.getItem("ssc-gs-theme") || "light");

    discoverCards().then(function (all) {
        cards = all;
        if (!cards.length) {
            showEmptyState();
            return;
        }
        buildJumpList();
        current = indexFromHash();
        render();
    });
})();

// ===== State and Utilities =====
const state = {
    groups: {},
    decks: {},
    tests: {},
    results: [],
    currentUser: "barista", // can be 'admin' or 'barista'
    view: "create"
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
function saveState() { localStorage.setItem('baristaState', JSON.stringify(state)); }
function loadState() {
    let saved = localStorage.getItem('baristaState');
    if (saved) Object.assign(state, JSON.parse(saved));
}
function randomize(arr) {
    return arr.map(a => [Math.random(), a]).sort((a, b) => a[0] - b[0]).map(a => a[1]);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

// ===== Groups and Decks =====
function addGroup(name) {
    if (!state.groups[name]) state.groups[name] = [];
    saveState();
}
function addDeck(group, name) {
    if (!state.decks[group]) state.decks[group] = {};
    if (!state.decks[group][name]) state.decks[group][name] = [];
    if (!state.groups[group].includes(name)) state.groups[group].push(name);
    saveState();
}
function addCard(group, deck, question, correct, wrong1, wrong2, wrong3, subcat) {
    state.decks[group][deck].push({
        question, correct,
        wrong: [wrong1, wrong2, wrong3].filter(Boolean),
        subcategory: subcat || ""
    });
    saveState();
}

// ===== Build & Share =====
function buildTest(testName, group, deckSelections, numQuestions) {
    let pool = [];
    deckSelections.forEach(deck => {
        let cards = state.decks[group][deck] || [];
        pool = pool.concat(cards);
    });
    pool = randomize(pool).slice(0, numQuestions);
    state.tests[testName] = { group, decks: deckSelections, questions: pool };
    saveState();
    return state.tests[testName];
}
function getShareURL(testName) {
    return `${location.origin}${location.pathname}?test=${encodeURIComponent(testName)}`;
}

// ===== Barista Quiz =====
function startQuiz(testName) {
    let test = state.tests[testName];
    if (!test) return alert("Test not found.");
    let quizData = randomize(test.questions).slice(0, 30); // shuffle each restart
    runQuizUI(quizData, testName);
}
function runQuizUI(questions, testName) {
    let index = 0;
    let correctCount = 0;
    const quizContainer = $('#quizContainer');
    function renderQ() {
        if (index >= questions.length) {
            finishQuiz();
            return;
        }
        let q = questions[index];
        quizContainer.innerHTML = `
            <div>
                <h3>${index + 1}. ${q.question}</h3>
                ${randomize([q.correct, ...q.wrong])
                    .map(ans => `<button class="answerBtn">${ans}</button>`).join('')}
            </div>
        `;
        $$('.answerBtn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.textContent === q.correct) correctCount++;
                index++;
                renderQ();
            });
        });
    }
    function finishQuiz() {
        quizContainer.innerHTML = `
            <h2>Finished!</h2>
            <p>You scored ${correctCount} out of ${questions.length}.</p>
        `;
        state.results.push({
            user: state.currentUser,
            test: testName,
            score: correctCount,
            total: questions.length,
            date: todayISO()
        });
        saveState();
    }
    renderQ();
}

// ===== Practice Mode =====
function startPractice(group, deckSelections) {
    let pool = [];
    deckSelections.forEach(deck => {
        let cards = state.decks[group][deck] || [];
        pool = pool.concat(cards);
    });
    runFlashcards(pool);
}
function runFlashcards(cards) {
    let index = 0;
    const practiceContainer = $('#practiceContainer');
    function renderCard() {
        if (index >= cards.length) index = 0;
        let card = cards[index];
        practiceContainer.innerHTML = `
            <div>
                <h3>${card.question}</h3>
                <button id="showAnswer">Show Answer</button>
            </div>
        `;
        $('#showAnswer').addEventListener('click', () => {
            practiceContainer.innerHTML = `
                <div>
                    <h3>${card.question}</h3>
                    <p>Answer: ${card.correct}</p>
                    <button id="nextCard">Next</button>
                </div>
            `;
            $('#nextCard').addEventListener('click', () => {
                index++;
                renderCard();
            });
        });
    }
    renderCard();
}

// ===== Reports =====
function renderReports() {
    const reportContainer = $('#reportsContainer');
    let rows = state.results.map(r =>
        `<tr>
            <td>${r.user}</td>
            <td>${r.test}</td>
            <td>${r.score}/${r.total}</td>
            <td>${r.date}</td>
        </tr>`
    ).join('');
    reportContainer.innerHTML = `
        <table>
            <tr><th>User</th><th>Test</th><th>Score</th><th>Date</th></tr>
            ${rows}
        </table>
    `;
}

// ===== Init =====
function boot() {
    loadState();
    // Attach all necessary event listeners here (admin create deck, share, quiz start, etc.)
}
boot();

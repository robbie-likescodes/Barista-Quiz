let decks = {};
let tests = {};

function showSection(id) {
  document.querySelectorAll('.page-section').forEach(sec => sec.style.display = 'none');
  document.getElementById(id).style.display = 'block';
}

// Create a deck
function createDeck() {
  const name = document.getElementById('deckName').value.trim();
  const category = document.getElementById('deckCategory').value.trim();
  if (!name) {
    alert("Please enter a deck name.");
    return;
  }
  decks[name] = { category, cards: [] };
  renderDeckList();
}

function renderDeckList() {
  const list = document.getElementById('deckList');
  list.innerHTML = '';
  for (let deck in decks) {
    const div = document.createElement('div');
    div.textContent = `${deck} (${decks[deck].category || "No category"})`;
    list.appendChild(div);
  }
}

// Build & Share test
function generateShareLink() {
  const testName = document.getElementById('testName').value.trim();
  const numQuestions = parseInt(document.getElementById('numQuestions').value);
  if (!testName) {
    alert("Please name the test.");
    return;
  }
  tests[testName] = { numQuestions, decks: Object.keys(decks) };
  const url = `${window.location.origin}${window.location.pathname}?test=${encodeURIComponent(testName)}`;
  document.getElementById('shareLink').value = url;
}

// Practice
function nextFlashcard() {
  document.getElementById('practiceArea').innerText = "Next flashcard coming soon...";
}

// Quiz
function submitQuiz() {
  alert("Quiz submitted! Results feature coming soon.");
}

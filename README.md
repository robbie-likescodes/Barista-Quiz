# Barista Academy

A responsive creator and student training application for building flashcard decks, publishing quizzes, and comparing results across locations. The browser provides an offline-friendly cache while Google Sheets, through Google Apps Script, stores published content and submissions.

## Experiences

- **Creator workspace:** access-key protected dashboard, content library, quiz builder, publishing, reporting, archives, imports, and backups.
- **Student workspace:** focused practice, quiz, device history, and privacy-safe leaderboards from a shared link.
- **Offline resilience:** completed attempts enter a persistent outbox and retry when the browser reconnects.

## Deploy the Apps Script backend

1. Open the Apps Script project connected to **Barista Quiz DB**.
2. Replace its `Code.gs` with [`apps_script/Code.gs`](apps_script/Code.gs).
3. In **Project Settings → Script Properties**, set:
   - `SPREADSHEET_ID` to the ID between `/d/` and `/edit` in the spreadsheet URL.
   - `API_KEY` to a long, randomly generated creator access key.
4. Ensure the spreadsheet has `Decks`, `Cards`, `Tests`, `Results`, `Archived`, and optional `Meta` tabs. The script creates or repairs row-one headers in existing tabs.
5. Deploy a new Web App version, executing as the owner and allowing anyone with the student link to access it.
6. Put the deployment `/exec` URL in `CLOUD.BASE` near the top of `app.js`.

The creator key is entered at runtime and retained only in `sessionStorage`; it is no longer shipped in the frontend source. Existing student links using `?mode=student&test=...` remain compatible.

## Security model

- Full content lists, identifiable results, backups, and destructive operations require the creator key.
- Student content requests are limited to the quiz named by the shared link.
- Public leaderboards return initials and aggregate score fields—not answer details, client identifiers, result IDs, or dates.
- Result submissions are validated, rate-limited, recalculated from submitted answer details, protected with a script lock, and deduplicated.
- Creator authorization is enforced by Apps Script. Hiding navigation is not treated as an authorization boundary.

For a high-stakes examination system, move grading to a transactional backend that never sends correct answers to the browser. This app is designed for workplace training and self-study, not proctored certification.

## Local development

The frontend is static and can be served by any HTTP server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Creator mode requires a live Apps Script deployment; student links can use data already cached by the browser when the cloud is temporarily unavailable.

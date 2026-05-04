# Divine Intervention Podcast Downloader

Downloads all MP3 episodes from [divineinterventionpodcasts.com](https://divineinterventionpodcasts.com) in series, with SQLite-backed resume support.

## Requirements

- Node.js 18+
- npm

## Setup

```bash
npm install
```

## Usage

```bash
node downloader.js
```

MP3s are saved to `./audio/`. Progress is stored in `downloads.db` so you can stop and restart at any time — it resumes from where it left off and skips already-downloaded files.

## Behavior

- Fetches pages sequentially starting from page 1 (or the last unfinished page on resume)
- Extracts all MP3 URLs from each page's HTML response
- Downloads each MP3 one at a time into `./audio/`
- Waits **10 seconds** between page requests
- Waits **5 seconds** between MP3 downloads
- Stops automatically when the site signals the last page

## Files

| File | Purpose |
|---|---|
| `downloader.js` | Main script |
| `downloads.db` | SQLite database tracking fetched pages and downloaded files |
| `audio/` | Downloaded MP3 files |

## Resume / Crash Recovery

If the process is interrupted, re-run `node downloader.js`. It will:
1. Read the highest completed page number from the DB
2. Resume fetching from the next page
3. Skip any MP3s already recorded in the DB

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');
const Database = require('better-sqlite3');

const BASE_URL = 'https://divineinterventionpodcasts.com/';
const AUDIO_DIR = path.join(__dirname, 'audio');
const DB_PATH = path.join(__dirname, 'downloads.db');
const PAGE_DELAY_MS = 10_000;
const MP3_DELAY_MS = 5_000;

// --- DB setup ---
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    page INTEGER PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    last_batch INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS downloads (
    url TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    downloaded_at TEXT NOT NULL
  );
`);

const stmts = {
  pageExists: db.prepare('SELECT 1 FROM pages WHERE page = ?'),
  insertPage: db.prepare('INSERT OR REPLACE INTO pages (page, fetched_at, last_batch) VALUES (?, ?, ?)'),
  lastPage: db.prepare('SELECT MAX(page) AS p FROM pages'),
  isDownloaded: db.prepare('SELECT 1 FROM downloads WHERE url = ?'),
  insertDownload: db.prepare('INSERT OR REPLACE INTO downloads (url, filename, downloaded_at) VALUES (?, ?, ?)'),
};

// --- Helpers ---
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cleanUrl(raw) {
  // Strip query params like ?_=1 added by WordPress audio shortcode
  try {
    const u = new URL(raw);
    u.search = '';
    return u.toString();
  } catch {
    return raw;
  }
}

function postRequest(page) {
  return new Promise((resolve, reject) => {
    const body = `page=${page}`;
    const options = {
      hostname: 'divineinterventionpodcasts.com',
      path: '/?infinity=scrolling',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (compatible; podcast-downloader/1.0)',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://divineinterventionpodcasts.com/',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Non-JSON response on page ${page}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Request timed out on page ${page}`));
    });
    req.write(body);
    req.end();
  });
}

function extractMp3Urls(html) {
  const root = parse(html);
  const urls = new Set();

  // <source type="audio/mpeg" src="...">
  for (const el of root.querySelectorAll('source[type="audio/mpeg"]')) {
    const src = el.getAttribute('src');
    if (src && src.endsWith('.mp3') || src && src.includes('.mp3?')) {
      urls.add(cleanUrl(src));
    }
  }

  // Fallback: <a href="...mp3"> links
  for (const el of root.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (href && href.includes('.mp3') && !href.includes('?')) {
      urls.add(cleanUrl(href));
    }
  }

  return [...urls];
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const attempt = (currentUrl, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));

      protocol.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          attempt(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
        }

        const tmp = destPath + '.part';
        const file = fs.createWriteStream(tmp);
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, destPath);
            resolve();
          });
        });
        file.on('error', err => {
          fs.unlink(tmp, () => {});
          reject(err);
        });
      }).on('error', reject);
    };

    attempt(url);
  });
}

function filenameFromUrl(url) {
  return path.basename(new URL(url).pathname);
}

// --- Main loop ---
async function run() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

  // Determine start page: resume from last completed page + 1, or 1
  const row = stmts.lastPage.get();
  let startPage = row && row.p ? row.p + 1 : 1;

  // If last page had lastbatch=1 we're done
  const lastRow = db.prepare('SELECT last_batch FROM pages WHERE page = ?').get(startPage - 1);
  if (lastRow && lastRow.last_batch === 1) {
    console.log('All pages already fetched. Only downloading missing MP3s from DB.');
    startPage = Infinity; // skip page fetching
  }

  console.log(`Starting from page ${startPage === Infinity ? '(none)' : startPage}`);

  let page = startPage === Infinity ? 1 : startPage;
  let done = startPage === Infinity;

  while (!done) {
    console.log(`\n[Page ${page}] Fetching...`);
    let response;
    try {
      response = await postRequest(page);
    } catch (err) {
      console.error(`  Error fetching page ${page}: ${err.message}`);
      console.log('  Retrying in 30s...');
      await sleep(30_000);
      continue;
    }

    if (response.type !== 'success' || !response.html) {
      console.log(`  No more pages (type=${response.type}). Stopping.`);
      break;
    }

    const mp3Urls = extractMp3Urls(response.html);
    console.log(`  Found ${mp3Urls.length} MP3(s) on page ${page}`);

    stmts.insertPage.run(page, new Date().toISOString(), response.lastbatch ? 1 : 0);

    for (const url of mp3Urls) {
      if (stmts.isDownloaded.get(url)) {
        console.log(`  [skip] Already downloaded: ${filenameFromUrl(url)}`);
        continue;
      }

      const filename = filenameFromUrl(url);
      const destPath = path.join(AUDIO_DIR, filename);

      console.log(`  [download] ${filename}`);
      try {
        await downloadFile(url, destPath);
        stmts.insertDownload.run(url, filename, new Date().toISOString());
        console.log(`  [done] ${filename}`);
      } catch (err) {
        console.error(`  [error] ${filename}: ${err.message}`);
      }

      console.log(`  Waiting ${MP3_DELAY_MS / 1000}s before next MP3...`);
      await sleep(MP3_DELAY_MS);
    }

    if (response.lastbatch) {
      console.log('\nReached last page. All done.');
      done = true;
    } else {
      page++;
      console.log(`Waiting ${PAGE_DELAY_MS / 1000}s before next page...`);
      await sleep(PAGE_DELAY_MS);
    }
  }

  db.close();
  console.log('\nFinished.');
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

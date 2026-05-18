import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// SQL запрос _stmtReadSeries из db.js — найти серии, где все книги прочитаны.
const READ_SERIES_SQL = `
  WITH candidate_series AS (
    SELECT DISTINCT sc.id AS series_id, sc.name AS series_name
    FROM read_books rb
    JOIN book_series bs ON bs.book_id = rb.book_id
    JOIN series_catalog sc ON sc.id = bs.series_id
    WHERE rb.username = ?
  )
  SELECT cs.series_name
  FROM candidate_series cs
  WHERE NOT EXISTS (
    SELECT 1 FROM book_series bs2
    JOIN active_books ab2 ON ab2.id = bs2.book_id
    WHERE bs2.series_id = cs.series_id
      AND NOT EXISTS (
        SELECT 1 FROM read_books rb2 WHERE rb2.username = ? AND rb2.book_id = bs2.book_id
      )
  )
`;

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      authors TEXT,
      series TEXT,
      series_no TEXT,
      deleted INTEGER DEFAULT 0
    );
    CREATE TABLE series_catalog (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      sort_name TEXT,
      search_name TEXT
    );
    CREATE TABLE book_series (
      book_id TEXT NOT NULL,
      series_id INTEGER NOT NULL,
      series_no TEXT
    );
    CREATE TABLE read_books (
      username TEXT NOT NULL,
      book_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIEW active_books AS SELECT * FROM books WHERE deleted = 0;
  `);
  return db;
}

function seedSeriesWithBooks(db, { seriesName, bookCount = 2 }) {
  const insertSeries = db.prepare('INSERT INTO series_catalog (name, display_name, sort_name, search_name) VALUES (?, ?, ?, ?)');
  const insertBook = db.prepare('INSERT INTO books (id, title, authors, series, series_no) VALUES (?, ?, ?, ?, ?)');
  const linkBook = db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)');
  const getSeriesId = db.prepare('SELECT id FROM series_catalog WHERE name = ?');

  insertSeries.run(seriesName, seriesName, seriesName, seriesName);
  const seriesId = getSeriesId.get(seriesName).id;

  for (let i = 1; i <= bookCount; i++) {
    const bookId = `${seriesName}_book_${i}`;
    insertBook.run(bookId, `Book ${i}`, 'Author', seriesName, String(i));
    linkBook.run(bookId, seriesId, String(i));
  }
  return { seriesId };
}

test('read_series SQL returns series name when all books are read', () => {
  const db = setupDb();
  seedSeriesWithBooks(db, { seriesName: 'Ведьмак', bookCount: 3 });

  const markRead = db.prepare('INSERT INTO read_books (username, book_id) VALUES (?, ?)');
  for (let i = 1; i <= 3; i++) {
    markRead.run('alice', `Ведьмак_book_${i}`);
  }

  const rows = db.prepare(READ_SERIES_SQL).all('alice', 'alice');
  const names = rows.map(r => r.series_name);
  assert.deepEqual(names, ['Ведьмак']);
});

test('read_series SQL returns nothing when not all books are read', () => {
  const db = setupDb();
  seedSeriesWithBooks(db, { seriesName: 'Ведьмак', bookCount: 3 });

  db.prepare('INSERT INTO read_books (username, book_id) VALUES (?, ?)').run('alice', 'Ведьмак_book_1');
  db.prepare('INSERT INTO read_books (username, book_id) VALUES (?, ?)').run('alice', 'Ведьмак_book_2');

  const rows = db.prepare(READ_SERIES_SQL).all('alice', 'alice');
  assert.equal(rows.length, 0);
});

test('read_series SQL: column name is series_name (not series)', () => {
  const db = setupDb();
  seedSeriesWithBooks(db, { seriesName: 'Тест', bookCount: 1 });
  db.prepare('INSERT INTO read_books (username, book_id) VALUES (?, ?)').run('alice', 'Тест_book_1');

  const row = db.prepare(READ_SERIES_SQL).get('alice', 'alice');
  assert.ok(row, 'row must exist');
  assert.strictEqual(row.series_name, 'Тест');
  assert.strictEqual(row.series, undefined, 'old buggy column "series" should not exist');
});

test('Set.has() matches when name is stored in original case (no toLowerCase)', () => {
  const db = setupDb();
  seedSeriesWithBooks(db, { seriesName: 'Маски [Метельский]', bookCount: 2 });
  db.prepare('INSERT INTO read_books (username, book_id) VALUES (?, ?)').run('alice', 'Маски [Метельский]_book_1');
  db.prepare('INSERT INTO read_books (username, book_id) VALUES (?, ?)').run('alice', 'Маски [Метельский]_book_2');

  const rows = db.prepare(READ_SERIES_SQL).all('alice', 'alice');
  // Имитируем _buildReadCache: кладём series_name в Set как есть (без toLowerCase)
  const series = new Set(rows.map(r => String(r.series_name || '')).filter(Boolean));

  // Имитируем шаблон: ищем has() с оригинальным именем из series_catalog
  const templateName = 'Маски [Метельский]';
  assert.strictEqual(series.has(templateName), true, 'Set must find series by original case-sensitive name');
});

test('Set.has() fails if name is lowercased (regression guard)', () => {
  const db = setupDb();
  seedSeriesWithBooks(db, { seriesName: 'Маски [Метельский]', bookCount: 1 });
  db.prepare('INSERT INTO read_books (username, book_id) VALUES (?, ?)').run('alice', 'Маски [Метельский]_book_1');

  const rows = db.prepare(READ_SERIES_SQL).all('alice', 'alice');
  // Старый баг: toLowerCase() в _buildReadCache
  const buggySeries = new Set(rows.map(r => String(r.series_name || '').toLowerCase()).filter(Boolean));

  const templateName = 'Маски [Метельский]';
  assert.strictEqual(buggySeries.has(templateName), false, 'lowercased Set must NOT find mixed-case name');
});

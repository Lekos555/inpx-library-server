import test from 'node:test';
import assert from 'node:assert';
import {
  bookIdNeedsSafeUrl,
  encodeBookRef,
  decodeBookRef,
  bookPagePath,
  apiBookPath,
  downloadBookPath
} from '../src/utils/book-ref.js';

const SAMPLE_ID = '8:791195\x00f.fb2-791176-794180.7z\x00791195\x00fb2';

test('bookIdNeedsSafeUrl detects NUL bytes', () => {
  assert.strictEqual(bookIdNeedsSafeUrl('normal-book-id.fb2'), false);
  assert.strictEqual(bookIdNeedsSafeUrl(SAMPLE_ID), true);
  assert.strictEqual(bookIdNeedsSafeUrl('line\nbreak'), true);
});

test('encodeBookRef round-trip', () => {
  const ref = encodeBookRef(SAMPLE_ID);
  assert.match(ref, /^[A-Za-z0-9_-]+$/);
  assert.strictEqual(decodeBookRef(ref), SAMPLE_ID);
});

test('bookPagePath uses b64 only for unsafe ids', () => {
  assert.strictEqual(bookPagePath('abc.fb2'), '/book/abc.fb2');
  assert.match(bookPagePath(SAMPLE_ID), /^\/book\/b64\//);
  assert.strictEqual(bookPagePath(SAMPLE_ID, '/edit'), bookPagePath(SAMPLE_ID) + '/edit');
});

test('api and download paths use b64 for unsafe ids', () => {
  assert.match(apiBookPath(SAMPLE_ID, 'cover'), /^\/api\/books\/b64\/.+\/cover$/);
  assert.match(downloadBookPath(SAMPLE_ID, 'format=fb2'), /^\/download\/b64\/.+\?format=fb2$/);
});

test('apiReadingHistoryPath uses b64 for unsafe ids', async () => {
  const { apiReadingHistoryPath } = await import('../src/utils/book-ref.js');
  assert.match(apiReadingHistoryPath(SAMPLE_ID), /^\/api\/reading-history\/b64\/.+/);
  assert.strictEqual(apiReadingHistoryPath('abc.fb2'), '/api/reading-history/abc.fb2');
});

import { t } from '../i18n.js';
import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  getReadingPosition, setReadingPosition,
  getReaderBookmarks, addReaderBookmark, deleteReaderBookmark,
  getReaderAnnotations, addReaderAnnotation, updateReaderAnnotation, deleteReaderAnnotation,
  upsertReadingHistoryEntry, deleteReadingHistoryEntry
} from '../db.js';
import { invalidateUserPageCaches, clearPageDataCache } from '../services/cache.js';
import { isBookRead, getBookById, addReadBooksIfMissing } from '../inpx.js';

/**
 * Reader-related API routes: position tracking, bookmarks, reading history.
 */
export function registerReaderRoutes(app) {
  /* ── Reading position ──────────────────────────────────────────── */

  app.get('/api/books/:id/position', requireApiAuth, asyncHandler(async (req, res) => {
    const pos = getReadingPosition(req.user.username, req.params.id);
    res.json(pos || { position: '', progress: 0 });
  }));

  app.post('/api/books/:id/position', requireApiAuth, asyncHandler(async (req, res) => {
    const { position, progress } = req.body;
    const bookId = req.params.id;
    const username = req.user.username;
    if (!getBookById(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const progressNum = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Number(progress))) : 0;
    const posStr = String(position || '');
    setReadingPosition(username, bookId, posStr, progressNum);
    invalidateUserPageCaches(username);
    // Auto-mark as read when progress reaches 99%+
    let markedRead = false;
    if (progressNum >= 99 && !isBookRead(username, bookId)) {
      addReadBooksIfMissing(username, [bookId]);
      markedRead = true;
    }
    res.json({ ok: true, markedRead });
  }));

  /* ── Auto-mark as read when finished ────────────────────────── */

  app.post('/api/books/:id/mark-read', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = req.params.id;
    if (isBookRead(req.user.username, bookId)) {
      return res.json({ ok: true, already: true });
    }
    if (!getBookById(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    addReadBooksIfMissing(req.user.username, [bookId]);
    res.json({ ok: true, marked: true });
  }));

  /* ── Reader bookmarks ──────────────────────────────────────────── */

  app.get('/api/books/:id/bookmarks', requireApiAuth, asyncHandler(async (req, res) => {
    res.json(getReaderBookmarks(req.user.username, req.params.id));
  }));

  app.post('/api/books/:id/bookmarks', requireApiAuth, asyncHandler(async (req, res) => {
    const position = String(req.body?.position ?? '');
    const title = String(req.body?.title ?? '');
    if (!position || position.length > 2000) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.bookmark.positionRequired'));
    }
    if (title.length > 500) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.bookmark.titleTooLong'));
    }
    if (!getBookById(req.params.id)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const id = addReaderBookmark(req.user.username, req.params.id, position, title);
    res.json({ ok: true, id: Number(id) });
  }));

  app.delete('/api/books/:id/bookmarks/:bmId', requireApiAuth, asyncHandler(async (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderBookmark(bmId, req.user.username);
    res.json({ ok: true });
  }));

  /* Legacy endpoint */
  app.delete('/api/reader-bookmarks/:bmId', requireApiAuth, asyncHandler(async (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderBookmark(bmId, req.user.username);
    res.json({ ok: true });
  }));

  /* ── Reader annotations (выделения и заметки) ──────────────────── */

  const ANNOTATION_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'underline']);

  app.get('/api/books/:id/annotations', requireApiAuth, asyncHandler(async (req, res) => {
    res.json(getReaderAnnotations(req.user.username, req.params.id));
  }));

  app.post('/api/books/:id/annotations', requireApiAuth, asyncHandler(async (req, res) => {
    const cfi = String(req.body?.cfi ?? '');
    const text = String(req.body?.text ?? '');
    const note = String(req.body?.note ?? '');
    const color = String(req.body?.color ?? 'yellow');
    if (!cfi || cfi.length > 2000) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.cfiRequired'));
    }
    if (text.length > 8000 || note.length > 8000) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.textTooLong'));
    }
    if (!ANNOTATION_COLORS.has(color)) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.invalidColor'));
    }
    if (!getBookById(req.params.id)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const id = addReaderAnnotation(req.user.username, req.params.id, cfi, text, note, color);
    res.json({ ok: true, id: Number(id) });
  }));

  app.patch('/api/books/:id/annotations/:aid', requireApiAuth, asyncHandler(async (req, res) => {
    const aid = Number(req.params.aid);
    if (!Number.isInteger(aid) || aid < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    const patch = {};
    if (req.body?.note !== undefined) {
      const note = String(req.body.note);
      if (note.length > 8000) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.textTooLong'));
      }
      patch.note = note;
    }
    if (req.body?.color !== undefined) {
      const color = String(req.body.color);
      if (!ANNOTATION_COLORS.has(color)) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.invalidColor'));
      }
      patch.color = color;
    }
    updateReaderAnnotation(aid, req.user.username, patch);
    res.json({ ok: true });
  }));

  app.delete('/api/books/:id/annotations/:aid', requireApiAuth, asyncHandler(async (req, res) => {
    const aid = Number(req.params.aid);
    if (!Number.isInteger(aid) || aid < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderAnnotation(aid, req.user.username);
    res.json({ ok: true });
  }));

  /* ── Reading history ───────────────────────────────────────────── */

  app.post('/api/reading-history/:bookId', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId || '');
    if (!bookId) {
      return apiFail(res, 400, ApiErrorCode.BOOK_INVALID_ID, t('api.book.invalidId'));
    }
    if (!getBookById(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const lastOpenedAt = String(req.body?.lastOpenedAt || '').trim();
    const openCountRaw = req.body?.openCount;
    const openCount = Number.isFinite(Number(openCountRaw)) ? Math.max(0, Math.floor(Number(openCountRaw))) : undefined;
    upsertReadingHistoryEntry(req.user.username, bookId, lastOpenedAt, openCount);
    invalidateUserPageCaches(req.user.username);
    res.json({ ok: true });
  }));

  app.delete('/api/reading-history/:bookId', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId || '');
    if (!bookId) {
      return apiFail(res, 400, ApiErrorCode.BOOK_INVALID_ID, t('api.book.invalidId'));
    }
    const deleted = deleteReadingHistoryEntry(req.user.username, bookId);
    if (!deleted) {
      return apiFail(res, 404, ApiErrorCode.NOT_FOUND, t('app.removeReadingFail'));
    }
    invalidateUserPageCaches(req.user.username);
    clearPageDataCache();
    res.json({ ok: true });
  }));
}

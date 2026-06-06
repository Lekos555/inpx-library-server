/**
 * Authentication and authorization middleware.
 */
import basicAuth from 'basic-auth';
import { getUserByUsername, getSetting } from '../db.js';
import { verifyPassword } from '../auth.js';
import { parseSession, csrfTokenForSession, verifyCsrfToken } from '../services/session.js';
import { trackUser } from '../services/online-tracker.js';
import { logSystemEvent } from '../services/system-events.js';
import { CSRF_EXEMPT_PATHS, DUMMY_PASSWORD_HASH, SESSION_USER_CACHE_TTL_MS, SESSION_USER_CACHE_MAX } from '../constants.js';
import { t } from '../i18n.js';
import { ApiErrorCode } from '../api-errors.js';

/* ── OPDS auth helpers (общие для requireOpdsAuth, requireBrowseOrOpds, requireDownloadAuth) ──
 * Сложилось так, что три функции дублировали почти одинаковую логику Basic Auth.
 * Выношу её в helper, плюс добавляю диагностический лог: без него админ при 401
 * видит только «Unauthorized» и не понимает, в чём дело (неверный логин? пароль?
 * заблокирован?). Лог идёт в system_events → доступен в админке. */

/**
 * Попытка авторизовать OPDS-клиент по Basic Auth.
 * Возвращает либо `{ ok: true, user }`, либо `{ ok: false, reason }` с одним из:
 *   'no-credentials' | 'unknown-user' | 'no-password-hash' | 'blocked' | 'wrong-password'
 * Никаких side-effects на response — это решает caller.
 */
function tryOpdsBasicAuth(req) {
  const credentials = basicAuth(req);
  if (!credentials) return { ok: false, reason: 'no-credentials' };
  const basicUser = getUserByUsername(credentials.name);
  if (!basicUser) {
    /* Всё равно вычисляем хеш дамми-пароля чтобы не было timing-side-channel
       («есть пользователь / нет»). Результат игнорируем. */
    verifyPassword(credentials.pass, DUMMY_PASSWORD_HASH);
    return { ok: false, reason: 'unknown-user', username: credentials.name };
  }
  if (!basicUser.passwordHash) {
    return { ok: false, reason: 'no-password-hash', username: basicUser.username };
  }
  if (basicUser.blocked) {
    return { ok: false, reason: 'blocked', username: basicUser.username };
  }
  const valid = verifyPassword(credentials.pass, basicUser.passwordHash);
  if (!valid) {
    return { ok: false, reason: 'wrong-password', username: basicUser.username };
  }
  return {
    ok: true,
    user: { username: basicUser.username, role: basicUser.role || 'user' }
  };
}

/**
 * Записать причину неудачной OPDS-авторизации в журнал событий
 * (тихо: не на каждом запросе, а только когда реально пришли credentials —
 * чтобы не флудить логи от клиентов, которые сначала шлют без Basic вообще).
 */
function logOpdsAuthFailure(req, result) {
  if (!result || result.ok) return;
  if (result.reason === 'no-credentials') return; // это нормальный «ping» от клиента до challenge
  try {
    logSystemEvent('warn', 'auth', 'OPDS basic-auth failed', {
      reason: result.reason,
      username: result.username || '',
      ip: req.ip || req.socket?.remoteAddress || '',
      path: req.originalUrl || req.path || ''
    });
  } catch { /* ignore */ }
}

/**
 * Стандартный 401-ответ для OPDS-клиента с UTF-8-charset
 * (RFC 7617 §2.1: клиент при наличии charset="UTF-8" обязан кодировать
 * Basic-credentials в UTF-8 — это чинит логины с не-ASCII в пароле/логине). */
function sendOpdsAuthChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="INPX Library OPDS", charset="UTF-8"');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  return res.status(401).send(t('api.auth.unauthorized'));
}

const sessionUserCache = new Map();

function getCachedUser(username) {
  const key = String(username || '').trim();
  if (!key) return null;
  const cached = sessionUserCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    sessionUserCache.delete(key);
    return null;
  }
  return cached.user;
}

function setCachedUser(username, user) {
  const key = String(username || '').trim();
  if (!key || !user) return;
  sessionUserCache.set(key, {
    user,
    expiresAt: Date.now() + SESSION_USER_CACHE_TTL_MS
  });
  if (sessionUserCache.size > SESSION_USER_CACHE_MAX) {
    let evicted = 0;
    for (const k of sessionUserCache.keys()) {
      sessionUserCache.delete(k);
      if (++evicted >= 100) break;
    }
  }
}

/** Extract the authenticated user from the session cookie. */
export function getSessionUser(req) {
  const session = parseSession(req.cookies.session);
  if (!session) return null;

  let user = getCachedUser(session.username);
  if (!user) {
    user = getUserByUsername(session.username);
    if (user) setCachedUser(session.username, user);
  }
  if (!user?.passwordHash) return null;

  const currentGen = user.sessionGen || 0;
  if (session.sessionGen !== currentGen) return null;
  if (user.blocked) return null;

  return { username: user.username, role: user.role || 'user', sessionGen: user.sessionGen || 0 };
}

/** Attach user and CSRF token to every request. */
export function attachSessionUser(req, res, next) {
  const user = getSessionUser(req);
  req.user = user || null;
  req.csrfToken = user ? csrfTokenForSession(user.username, user.sessionGen || 0) : '';
  if (user?.username) {
    trackUser(user.username);
  }
  next();
}

/** CSRF guard for mutating requests. */
export function csrfGuard(req, res, next) {
  const method = req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

  const reqPath = req.path || '';
  if (CSRF_EXEMPT_PATHS.has(reqPath)) return next();
  if (!req.user) return next();

  const headerToken = req.get('x-csrf-token');
  const body = req.body;
  const bodyToken =
    body && typeof body === 'object' && !Buffer.isBuffer(body) && body._csrf !== undefined
      ? body._csrf
      : undefined;
  const token = headerToken || bodyToken;

  if (!verifyCsrfToken(req.user.username, req.user.sessionGen || 0, token)) {
    if (reqPath.startsWith('/api/')) {
      return res.status(403).json({ ok: false, code: ApiErrorCode.CSRF_INVALID, error: t('api.auth.csrfInvalid') });
    }
    return res.status(403).type('text').send(t('auth.csrfInvalid'));
  }
  next();
}

// --- Route-level guards ---

export function requireWebAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

export function requireApiAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  next();
}

export function requireAdminWeb(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.redirect('/admin/login');
  next();
}

export function requireAdminApi(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, code: ApiErrorCode.FORBIDDEN_ADMIN, error: t('api.auth.adminRequired') });
  }
  next();
}

function isAnonymousAllowed(key) {
  return getSetting(key) === '1';
}

export function requireBrowseAuth(req, res, next) {
  if (req.user?.username) {
    trackUser(req.user.username);
    return next();
  }
  if (isAnonymousAllowed('allow_anonymous_browse')) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireBrowseOrOpds(req, res, next) {
  if (req.user?.username) {
    trackUser(req.user.username);
    return next();
  }
  if (isAnonymousAllowed('allow_anonymous_browse')) return next();
  const isOpds = String(req.query?.opds || '') === '1';
  if (isOpds && isAnonymousAllowed('allow_anonymous_opds')) return next();
  if (isOpds) {
    const result = tryOpdsBasicAuth(req);
    if (result.ok) {
      req.user = result.user;
      return next();
    }
    logOpdsAuthFailure(req, result);
    return sendOpdsAuthChallenge(res);
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireDownloadAuth(req, res, next) {
  if (req.user) return next();
  if (isAnonymousAllowed('allow_anonymous_download')) return next();
  const isOpds = String(req.query?.opds || '') === '1';
  if (isOpds && isAnonymousAllowed('allow_anonymous_opds')) return next();
  if (isOpds) {
    const result = tryOpdsBasicAuth(req);
    if (result.ok) {
      req.user = result.user;
      return next();
    }
    logOpdsAuthFailure(req, result);
    return sendOpdsAuthChallenge(res);
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireOpdsAuth(req, res, next) {
  /* Сначала пробуем Basic Auth — это «родной» путь для OPDS.
     Если Basic-credentials пришли, но не подошли — НЕ падаем сразу:
     админ мог быть залогинен через web-сессию, тогда cookie тоже валиден. */
  const basicResult = tryOpdsBasicAuth(req);
  let user = basicResult.ok ? basicResult.user : null;

  if (!user) {
    const sessionUser = getSessionUser(req);
    if (sessionUser) user = { username: sessionUser.username, role: sessionUser.role || 'user' };
  }

  if (user) {
    req.user = user;
    return next();
  }

  if (isAnonymousAllowed('allow_anonymous_opds')) {
    req.user = null;
    return next();
  }

  /* Логируем причину провала только если клиент реально пытался передать credentials
     (no-credentials означает первый запрос «на разведку» — не флудим этим лог). */
  logOpdsAuthFailure(req, basicResult);
  return sendOpdsAuthChallenge(res);
}

import { config } from '../config.js';

/*
 * Ленивая и безопасная загрузка sharp.
 *
 * sharp тянет нативный libvips, собранный с baseline-инструкциями SSE4.2/AVX.
 * На старых x86 CPU без этих инструкций (например Intel Atom Cedarview D2xxx)
 * модуль падает с SIGILL прямо при загрузке/первом вызове — это жёсткий сигнал,
 * который нельзя поймать через try/catch, он роняет весь процесс.
 *
 * Поэтому модуль загружается лениво (не на старте сервера) и только если
 * config.coverProcessingEnabled === true. При отключённой обработке обложки
 * отдаются как есть, без ресайза/конвертации.
 */

let _sharp = null;
let _loadAttempted = false;
let _available = false;

/**
 * Возвращает функцию sharp либо null, если обработка обложек отключена
 * или модуль недоступен. Никогда не бросает исключение.
 * @returns {Promise<Function|null>}
 */
export async function getSharp() {
  if (_loadAttempted) {
    return _available ? _sharp : null;
  }
  _loadAttempted = true;

  if (!config.coverProcessingEnabled) {
    return null;
  }

  try {
    const mod = await import('sharp');
    _sharp = mod.default;
    _available = true;
  } catch (err) {
    _available = false;
    console.warn('[cover] sharp недоступен — обработка обложек отключена:', err.message);
  }

  return _available ? _sharp : null;
}

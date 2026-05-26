/**
 * Standalone нагрузочный тест для inpx-library-server.
 * Запуск: node bench/load-test.js http://192.168.1.100:3000
 *
 * Не требует npm install — использует только Node.js built-ins.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── Конфигурация по умолчанию ───────────────────────────────────────────────
const DEFAULT_DURATION_PER_PHASE = 15; // секунд на фазу
const DEFAULT_PHASES = [1, 3, 5, 10, 20, 30]; // concurrent users
const DEFAULT_TIMEOUT_MS = 15000;

// ─── Парсинг аргументов ─────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const target = args[0] || 'http://localhost:3000';
  const duration = Number(args.find((a) => a.startsWith('--duration='))?.split('=')[1]) || DEFAULT_DURATION_PER_PHASE;
  const phasesArg = args.find((a) => a.startsWith('--phases='))?.split('=')[1];
  const phases = phasesArg ? phasesArg.split(',').map(Number) : DEFAULT_PHASES;
  const limitBytes = Number(args.find((a) => a.startsWith('--limit-download-bytes='))?.split('=')[1]) || 0;
  const timeout = Number(args.find((a) => a.startsWith('--timeout='))?.split('=')[1]) || DEFAULT_TIMEOUT_MS;
  return { target, duration, phases, limitBytes, timeout };
}

const CONFIG = parseArgs();

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function request(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: options.method || 'GET',
        timeout: options.timeout || CONFIG.timeout,
        headers: { 'User-Agent': 'inpx-load-test/1.0', ...(options.headers || {}) },
      },
      (res) => {
        const chunks = [];
        let received = 0;
        let shouldStop = false;
        const limit = options.limitBytes ?? CONFIG.limitBytes;
        res.on('data', (chunk) => {
          if (shouldStop) return;
          if (limit) {
            const take = Math.min(chunk.length, limit - received);
            chunks.push(chunk.slice(0, take));
            received += take;
            if (received >= limit) shouldStop = true;
          } else {
            chunks.push(chunk);
            received += chunk.length;
          }
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, bytes: received });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

// ─── Получение book IDs из каталога ─────────────────────────────────────────
async function discoverBookIds(target) {
  try {
    const url = `${target}/catalog`;
    const res = await request(url, { timeout: 30000 });
    if (res.status !== 200) return [];
    // Будем запрашивать через /api/browse?limit=50, чтобы получить JSON
    const apiUrl = `${target}/api/browse?limit=50`;
    const apiRes = await request(apiUrl, { timeout: 30000 });
    if (apiRes.status !== 200) return [];
    // Парсим JSON — но нам нужен буфер, а мы его не сохраняем в request.
    // Переделаем discover через request с returnBody.
    return [];
  } catch {
    return [];
  }
}

// request с возвратом тела
function requestBody(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: options.method || 'GET',
        timeout: options.timeout || CONFIG.timeout,
        headers: { 'User-Agent': 'inpx-load-test/1.0', ...(options.headers || {}) },
      },
      (res) => {
        const chunks = [];
        let received = 0;
        let shouldStop = false;
        const limit = options.limitBytes || 0;
        res.on('data', (chunk) => {
          if (shouldStop) return;
          if (limit) {
            const take = Math.min(chunk.length, limit - received);
            chunks.push(chunk.slice(0, take));
            received += take;
            if (received >= limit) shouldStop = true;
          } else {
            chunks.push(chunk);
            received += chunk.length;
          }
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, bytes: received, body });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function extractIdsFromPage(target, path) {
  try {
    const { body, status } = await requestBody(`${target}${path}`, { limitBytes: 256 * 1024, timeout: 30000 });
    if (status !== 200) return { ids: [], status };
    const html = body.toString('utf-8');
    const ids = [];
    const re = /data-book-id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      ids.push(m[1]);
    }
    return { ids: [...new Set(ids)], status };
  } catch (e) {
    return { ids: [], status: 0, error: e.message };
  }
}

async function fetchBookIds(target) {
  // Основной источник — /library/recent, там больше всего книг
  const sources = ['/library/recent', '/catalog', '/'];
  for (const src of sources) {
    const { ids, status, error } = await extractIdsFromPage(target, src);
    if (ids.length) {
      console.log(`  → Найдено ${ids.length} ID на ${src}`);
      return ids.slice(0, 200);
    }
    if (error) {
      console.log(`  → ${src}: ошибка (${error})`);
    } else {
      console.log(`  → ${src}: статус ${status}, ID не найдены`);
    }
  }
  console.log(`  → Используем фиктивные ID (тест без book/download)`);
  return [];
}

// ─── Сценарии ────────────────────────────────────────────────────────────────
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function scenarioHome(target) {
  const t0 = performance.now();
  const { status } = await request(`${target}/`);
  return { ok: status === 200 || status === 302, ms: performance.now() - t0 };
}

async function scenarioCatalog(target) {
  const t0 = performance.now();
  const { status } = await request(`${target}/catalog`);
  return { ok: status === 200 || status === 302, ms: performance.now() - t0 };
}

async function scenarioBookPage(target, bookIds) {
  const id = pick(bookIds);
  const t0 = performance.now();
  const { status } = await request(`${target}/book/${encodeURIComponent(id)}`);
  return { ok: status === 200, ms: performance.now() - t0 };
}

async function scenarioCoverThumb(target, bookIds) {
  const id = pick(bookIds);
  const t0 = performance.now();
  const { status, bytes } = await request(`${target}/api/books/${encodeURIComponent(id)}/cover-thumb`, { timeout: 10000 });
  return { ok: status === 200, ms: performance.now() - t0, bytes };
}

async function scenarioDownload(target, bookIds) {
  const id = pick(bookIds);
  const t0 = performance.now();
  const limit = CONFIG.limitBytes || 64 * 1024; // по умолчанию ограничиваем скачивание
  const { status, bytes } = await request(`${target}/download/${encodeURIComponent(id)}`, { limitBytes: limit, timeout: 30000 });
  return { ok: status === 200 || status === 302, ms: performance.now() - t0, bytes };
}

async function scenarioLibraryRecent(target) {
  const t0 = performance.now();
  const { status } = await request(`${target}/library/recent`);
  return { ok: status === 200 || status === 302, ms: performance.now() - t0 };
}

async function scenarioSearch(target) {
  const terms = ['love', 'war', 'adventure', 'mystery', 'science', 'history', 'magic', 'dream', 'star', 'night'];
  const q = pick(terms);
  const t0 = performance.now();
  const { status } = await request(`${target}/catalog?q=${encodeURIComponent(q)}`);
  return { ok: status === 200 || status === 302, ms: performance.now() - t0 };
}

async function runScenario(target, bookIds) {
  const scenarios = [
    { fn: scenarioHome, weight: 15 },
    { fn: scenarioCatalog, weight: 20 },
    { fn: scenarioLibraryRecent, weight: 15 },
    { fn: scenarioBookPage, weight: bookIds.length ? 20 : 0 },
    { fn: scenarioCoverThumb, weight: bookIds.length ? 15 : 0 },
    { fn: scenarioDownload, weight: bookIds.length ? 10 : 0 },
    { fn: scenarioSearch, weight: 15 },
  ].filter((sc) => sc.weight > 0);
  const totalWeight = scenarios.reduce((s, sc) => s + sc.weight, 0);
  let r = Math.random() * totalWeight;
  for (const sc of scenarios) {
    r -= sc.weight;
    if (r <= 0) {
      return sc.fn(target, bookIds);
    }
  }
  return scenarios[0].fn(target, bookIds);
}

// ─── Воркер ──────────────────────────────────────────────────────────────────
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function worker(target, bookIds, durationSec, metrics, workerIndex) {
  const end = performance.now() + durationSec * 1000;
  let errorCount = 0;
  while (performance.now() < end) {
    try {
      const { ok, ms, bytes } = await runScenario(target, bookIds);
      metrics.push({ ok, ms: Math.round(ms), bytes: bytes || 0 });
    } catch (e) {
      errorCount++;
      if (errorCount <= 3) {
        console.log(`  [worker-${workerIndex}] ошибка: ${e.message || 'unknown'}`);
      }
      metrics.push({ ok: false, ms: CONFIG.timeout, error: e.message || 'error' });
    }
    // Think time: реальный пользователь не кликает без паузы
    const thinkTime = 1000 + Math.random() * 2000; // 1–3 секунды
    await sleep(thinkTime);
  }
}

// ─── Фаза ────────────────────────────────────────────────────────────────────
async function runPhase(target, bookIds, concurrency, durationSec) {
  const metrics = [];
  const workers = Array.from({ length: concurrency }, (_, i) => worker(target, bookIds, durationSec, metrics, i));
  const phaseStart = performance.now();
  await Promise.all(workers);
  const phaseMs = performance.now() - phaseStart;
  return { metrics, phaseMs };
}

// ─── Отчёт ───────────────────────────────────────────────────────────────────
function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function reportPhase(concurrency, durationSec, { metrics, phaseMs }) {
  const total = metrics.length;
  const ok = metrics.filter((m) => m.ok).length;
  const errors = total - ok;
  const latencies = metrics.map((m) => m.ms).sort((a, b) => a - b);
  const totalBytes = metrics.reduce((s, m) => s + (m.bytes || 0), 0);
  const rps = total / (phaseMs / 1000);

  const lines = [
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  Фаза: ${concurrency} параллельных пользователей · ${durationSec} сек`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  Запросов всего:      ${total}`,
    `  Успешных:            ${ok} (${((ok / total) * 100).toFixed(1)}%)`,
    `  Ошибок:              ${errors}`,
    `  RPS:                 ${rps.toFixed(1)}`,
    `  Передано данных:     ${formatBytes(totalBytes)}`,
    `  ───── Latency ─────`,
    `    min:               ${latencies[0]?.toFixed(0) || 0} ms`,
    `    avg:               ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)} ms`,
    `    p50:               ${percentile(latencies, 50)?.toFixed(0) || 0} ms`,
    `    p90:               ${percentile(latencies, 90)?.toFixed(0) || 0} ms`,
    `    p99:               ${percentile(latencies, 99)?.toFixed(0) || 0} ms`,
    `    max:               ${latencies[latencies.length - 1]?.toFixed(0) || 0} ms`,
  ];
  console.log(lines.join('\n'));
  return { total, ok, errors, rps, p90: percentile(latencies, 90), p99: percentile(latencies, 99), avg: latencies.reduce((a, b) => a + b, 0) / latencies.length };
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function printSummary(results) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ИТОГОВЫЙ ОТЧЁТ`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Пользователей │ RPS     │ Ошибок │ p90 latency │ Статус`);
  console.log(`  ──────────────┼─────────┼────────┼─────────────┼────────────────────`);

  let lastOk = true;
  for (const r of results) {
    const errorRate = r.total ? r.errors / r.total : 0;
    const status = errorRate > 0.1 || r.p90 > 5000 ? 'ДЕГРАДАЦИЯ' : errorRate > 0 || r.p90 > 1000 ? 'НАГРУЖЕН' : 'OK';
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`  ${pad(r.concurrency, 13)} │ ${pad(r.rps.toFixed(1), 7)} │ ${pad(r.errors, 6)} │ ${pad(r.p90.toFixed(0) + ' ms', 11)} │ ${status}`);
    if (errorRate > 0.1 || r.p90 > 5000) lastOk = false;
  }

  const lastGood = results.slice().reverse().find((r) => {
    const errorRate = r.total ? r.errors / r.total : 0;
    return errorRate < 0.1 && r.p90 < 3000;
  });
  const limit = lastGood ? lastGood.concurrency : 1;

  console.log(`\n  ═════════════════════════════════════════════════════════════════════`);
  console.log(`  РЕКОМЕНДАЦИЯ: сервер стабильно держит ~${limit} одновременных`);
  console.log(`  пользователей при комфортной задержке (< 3 с).`);
  if (!lastOk) {
    console.log(`  При дальнейшем увеличении начинаются ошибки или высокий latency.`);
  }
  console.log(`  ═════════════════════════════════════════════════════════════════════`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const target = CONFIG.target.replace(/\/$/, '');
  console.log(`inpx-library-server load test`);
  console.log(`Target: ${target}`);
  console.log(`Phases: ${CONFIG.phases.join(', ')} users`);
  console.log(`Duration per phase: ${CONFIG.duration} s`);
  if (CONFIG.limitBytes) console.log(`Download limit: ${formatBytes(CONFIG.limitBytes)}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  console.log(`\n[1/3] Проверка связи...`);
  try {
    const { status } = await request(`${target}/`, { timeout: 10000 });
    if (![200, 301, 302, 307, 308].includes(status)) {
      console.error(`Ошибка: сервер вернул ${status}. Убедитесь, что он запущен.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Ошибка соединения: ${e.message}`);
    process.exit(1);
  }
  console.log('Сервер отвечает.');

  console.log(`\n[2/3] Сбор ID книг из каталога...`);
  const bookIds = await fetchBookIds(target);
  if (!bookIds.length) {
    console.warn('Не удалось извлечь ID книг — сценарии book/download будут пропущены.');
  } else {
    console.log(`Найдено ${bookIds.length} книг для теста.`);
  }

  console.log(`\n[3/3] Нагрузочное тестирование...`);
  const results = [];
  for (const concurrency of CONFIG.phases) {
    const phaseRes = await runPhase(target, bookIds, concurrency, CONFIG.duration);
    const report = reportPhase(concurrency, CONFIG.duration, phaseRes);
    results.push({ concurrency, ...report });

    // Если деградация сильная — останавливаемся
    if (report.errors > report.total * 0.1 || report.p90 > 10000) {
      console.log(`\n  !!! Сильная деградация на ${concurrency} пользователях. Остановка.`);
      break;
    }
  }

  printSummary(results);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

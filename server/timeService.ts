import type { BrasiliaTimeSync } from '../shared/types.ts';

let cachedOffsetMs = 0;
let cachedSource: BrasiliaTimeSync['source'] = 'system-tz-fallback';
let lastSyncAt = 0;
const SYNC_TTL_MS = 60_000;

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 2500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function formatTimestampBrt(unixMs: number): Omit<BrasiliaTimeSync, 'unixMs' | 'timezone' | 'source' | 'offsetMs'> {
  const date = new Date(unixMs);

  const partsFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((p) => [p.type, p.value]),
  );

  const hour = parts.hour === '24' ? '00' : parts.hour;
  const dateBrt = `${parts.day}/${parts.month}/${parts.year}`;
  const timeBrt = `${hour}:${parts.minute}:${parts.second}`;
  const shortTimeBrt = `${hour}:${parts.minute}`;
  const isoBrt = `${parts.year}-${parts.month}-${parts.day}T${timeBrt}-03:00`;

  return {
    isoBrt,
    dateBrt,
    timeBrt,
    shortTimeBrt,
  };
}

export async function getSynchronizedBrasiliaTime(forceRefresh = false): Promise<BrasiliaTimeSync> {
  const now = Date.now();

  if (!forceRefresh && now - lastSyncAt < SYNC_TTL_MS && lastSyncAt > 0) {
    const syncedMs = now + cachedOffsetMs;
    return {
      unixMs: syncedMs,
      ...formatTimestampBrt(syncedMs),
      timezone: 'America/Sao_Paulo',
      source: cachedSource,
      offsetMs: cachedOffsetMs,
    };
  }

  // Primary external time source: TimeAPI.io America/Sao_Paulo
  try {
    const t0 = Date.now();
    const res = await fetchWithTimeout(
      'https://timeapi.io/api/Time/current/zone?timeZone=America/Sao_Paulo',
      { headers: { Accept: 'application/json' } },
      2500,
    );
    const t1 = Date.now();
    if (res.ok) {
      const data = (await res.json()) as { dateTime?: string };
      if (data.dateTime) {
        const cleanDt = data.dateTime.split('.')[0];
        const remoteUnix = new Date(`${cleanDt}-03:00`).getTime();
        if (!Number.isNaN(remoteUnix)) {
          const rttHalf = Math.round((t1 - t0) / 2);
          cachedOffsetMs = remoteUnix + rttHalf - t1;
          cachedSource = 'timeapi';
          lastSyncAt = t1;
          const syncedMs = Date.now() + cachedOffsetMs;
          return {
            unixMs: syncedMs,
            ...formatTimestampBrt(syncedMs),
            timezone: 'America/Sao_Paulo',
            source: cachedSource,
            offsetMs: cachedOffsetMs,
          };
        }
      }
    }
  } catch {
    // Fallback to HTTP Date header sync
  }

  // Secondary reliable network sync: Binance / Google HTTP Date header
  for (const probeUrl of ['https://api.binance.com/api/v3/time', 'https://www.google.com']) {
    try {
      const t0 = Date.now();
      const res = await fetchWithTimeout(probeUrl, { method: probeUrl.includes('binance') ? 'GET' : 'HEAD' }, 2200);
      const t1 = Date.now();
      const rttHalf = Math.round((t1 - t0) / 2);

      if (probeUrl.includes('binance') && res.ok) {
        const data = (await res.json()) as { serverTime?: number };
        if (typeof data.serverTime === 'number') {
          cachedOffsetMs = data.serverTime + rttHalf - t1;
          cachedSource = 'http-date-sync';
          lastSyncAt = t1;
          const syncedMs = Date.now() + cachedOffsetMs;
          return {
            unixMs: syncedMs,
            ...formatTimestampBrt(syncedMs),
            timezone: 'America/Sao_Paulo',
            source: cachedSource,
            offsetMs: cachedOffsetMs,
          };
        }
      }

      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        const headerMs = new Date(dateHeader).getTime();
        if (!Number.isNaN(headerMs)) {
          cachedOffsetMs = headerMs + rttHalf - t1;
          cachedSource = 'http-date-sync';
          lastSyncAt = t1;
          const syncedMs = Date.now() + cachedOffsetMs;
          return {
            unixMs: syncedMs,
            ...formatTimestampBrt(syncedMs),
            timezone: 'America/Sao_Paulo',
            source: cachedSource,
            offsetMs: cachedOffsetMs,
          };
        }
      }
    } catch {
      // Try next probe
    }
  }

  // Deterministic timezone fallback if offline/sandboxed
  cachedOffsetMs = 0;
  cachedSource = 'system-tz-fallback';
  lastSyncAt = now;
  return {
    unixMs: now,
    ...formatTimestampBrt(now),
    timezone: 'America/Sao_Paulo',
    source: cachedSource,
    offsetMs: 0,
  };
}

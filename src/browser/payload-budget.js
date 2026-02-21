const ENVELOPE_KEYS = new Set([
  'ok',
  'requestId',
  'timestamp',
  'pageId',
  'url',
  'title',
  'domVersion',
  'activeFrameId',
  'error'
]);

const REQUIRED_TRUNCATION_KEYS = new Set([
  'truncated',
  'truncationReason',
  'maxPayloadBytes'
]);

function estimateBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Buffer.byteLength(String(value ?? ''), 'utf8');
  }
}

function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (maxChars <= 0 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

function cloneJsonSafe(value) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch {
    // fallback below
  }
  return JSON.parse(JSON.stringify(value));
}

function trimArray(value, maxItems) {
  if (!Array.isArray(value)) return value;
  if (value.length <= maxItems) return value;
  return value.slice(0, maxItems);
}

function trimObjectKeys(value, maxKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length <= maxKeys) return value;
  const out = {};
  for (let i = 0; i < maxKeys; i += 1) {
    const key = keys[i];
    out[key] = value[key];
  }
  return out;
}

function compactError(errorValue) {
  if (!errorValue || typeof errorValue !== 'object' || Array.isArray(errorValue)) return undefined;
  const code = String(errorValue.code || 'INTERNAL');
  const message = truncateText(String(errorValue.message || 'Unknown error'), 240);
  const out = { code, message };
  if (errorValue.details && typeof errorValue.details === 'object' && !Array.isArray(errorValue.details)) {
    out.details = trimObjectKeys(errorValue.details, 8);
  }
  return out;
}

function reduceAnyValue(value, key = '') {
  if (typeof value === 'string') {
    const lowCaps = {
      requestId: 64,
      timestamp: 40,
      url: 240,
      title: 120,
      domVersion: 120,
      activeFrameId: 120
    };
    const floor = lowCaps[key] ?? 96;
    const nextMax = Math.max(floor, Math.floor(value.length / 2));
    return truncateText(value, nextMax);
  }

  if (Array.isArray(value)) {
    if (value.length <= 1) return [];
    return value.slice(0, Math.max(1, Math.floor(value.length / 2)));
  }

  if (value && typeof value === 'object') {
    if (key === 'error') {
      return compactError(value);
    }
    const keys = Object.keys(value);
    if (!keys.length) return {};
    const keep = Math.max(1, Math.floor(keys.length / 2));
    const out = {};
    for (let i = 0; i < keep; i += 1) {
      const k = keys[i];
      const v = value[k];
      out[k] = typeof v === 'string' ? truncateText(v, 240) : v;
    }
    return out;
  }

  // Primitive numbers/booleans/null are dropped first when aggressively shrinking.
  return undefined;
}

function ensureFitsBudget(payload, maxBytes, originalBytes) {
  let candidate = payload;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    candidate = {
      truncated: true,
      truncationReason: 'response_payload_budget_exceeded',
      maxPayloadBytes: maxBytes,
      originalBytes,
      data: truncateText(String(payload ?? ''), 512)
    };
  }

  const addTruncationMeta = () => {
    candidate.truncated = true;
    candidate.truncationReason = 'response_payload_budget_exceeded';
    candidate.maxPayloadBytes = maxBytes;
    if (typeof originalBytes === 'number') candidate.originalBytes = originalBytes;
  };
  addTruncationMeta();

  let loops = 0;
  while (estimateBytes(candidate) > maxBytes && loops < 24) {
    loops += 1;
    const keys = Object.keys(candidate)
      .filter((key) => !REQUIRED_TRUNCATION_KEYS.has(key))
      .sort((a, b) => estimateBytes(candidate[b]) - estimateBytes(candidate[a]));

    if (!keys.length) break;

    let changed = false;
    for (const key of keys) {
      const reduced = reduceAnyValue(candidate[key], key);
      if (typeof reduced === 'undefined') {
        if (Object.prototype.hasOwnProperty.call(candidate, key)) {
          delete candidate[key];
          changed = true;
        }
      } else if (reduced !== candidate[key]) {
        candidate[key] = reduced;
        changed = true;
      }

      if (estimateBytes(candidate) <= maxBytes) break;
    }

    if (!changed) break;
  }

  if (estimateBytes(candidate) > maxBytes) {
    const minimal = {
      truncated: true,
      truncationReason: 'response_payload_budget_exceeded',
      maxPayloadBytes: maxBytes
    };
    if (typeof payload?.ok === 'boolean') minimal.ok = payload.ok;
    if (typeof payload?.requestId === 'string') minimal.requestId = truncateText(payload.requestId, 64);
    if (typeof originalBytes === 'number') minimal.originalBytes = originalBytes;
    candidate = minimal;
  }

  // Final guard: strictly guarantee the response never exceeds the configured budget.
  while (estimateBytes(candidate) > maxBytes) {
    if (Object.prototype.hasOwnProperty.call(candidate, 'originalBytes')) {
      delete candidate.originalBytes;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(candidate, 'requestId')) {
      candidate.requestId = truncateText(candidate.requestId, Math.max(8, Math.floor(candidate.requestId.length / 2)));
      if (candidate.requestId.length <= 8) delete candidate.requestId;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(candidate, 'ok')) {
      delete candidate.ok;
      continue;
    }
    // Absolute floor.
    candidate = { truncated: true };
    if (estimateBytes(candidate) <= maxBytes) break;
  }

  return candidate;
}

function reduceTopLevelField(payload, key, value) {
  if (typeof value === 'string') {
    const maxChars = key === 'html' ? 2500 : 3000;
    payload[key] = truncateText(value, maxChars);
    return;
  }

  if (Array.isArray(value)) {
    const targetedLimits = {
      nodes: 120,
      items: 120,
      links: 60,
      requests: 60,
      messages: 60,
      dialogs: 60,
      questions: 80,
      results: 80,
      texts: 80
    };
    const limit = targetedLimits[key] ?? 80;
    payload[key] = trimArray(value, limit);
    return;
  }

  if (value && typeof value === 'object') {
    payload[key] = trimObjectKeys(value, 40);
  }
}

function buildFallbackPayload(payload, maxBytes, originalBytes) {
  const minimal = {};
  for (const key of ENVELOPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      if (key === 'error') {
        minimal[key] = compactError(payload[key]);
      } else if (typeof payload[key] === 'string') {
        minimal[key] = reduceAnyValue(payload[key], key);
      } else {
        minimal[key] = payload[key];
      }
    }
  }

  const passthrough = [
    'status',
    'eventType',
    'selector',
    'question',
    'count',
    'returned',
    'totalMatches',
    'downloadId',
    'dialogId',
    'popupId',
    'savedPath'
  ];
  for (const key of passthrough) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      minimal[key] = payload[key];
    }
  }

  minimal.truncated = true;
  minimal.truncationReason = 'response_payload_budget_exceeded';
  minimal.originalBytes = originalBytes;
  minimal.maxPayloadBytes = maxBytes;
  minimal.retryWith = {
    detail: 'low',
    fullPage: false,
    maxItems: 80,
    limit: 20,
    includeText: false,
    includeBBox: false
  };
  return ensureFitsBudget(minimal, maxBytes, originalBytes);
}

export function enforcePayloadCeiling(payload, opts = {}) {
  const maxBytes = typeof opts.maxBytes === 'number' && opts.maxBytes > 1024
    ? Math.floor(opts.maxBytes)
    : 280000;

  const originalBytes = estimateBytes(payload);
  if (originalBytes <= maxBytes) {
    return {
      payload,
      truncated: false,
      originalBytes,
      finalBytes: originalBytes
    };
  }

  let candidate = cloneJsonSafe(payload);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    candidate = buildFallbackPayload(
      { data: truncateText(String(payload ?? ''), 2000) },
      maxBytes,
      originalBytes
    );
    const finalBytes = estimateBytes(candidate);
    return {
      payload: candidate,
      truncated: true,
      originalBytes,
      finalBytes
    };
  }

  const nonEnvelopeKeys = Object.keys(candidate).filter((key) => !ENVELOPE_KEYS.has(key));

  for (const key of nonEnvelopeKeys) {
    const value = candidate[key];
    reduceTopLevelField(candidate, key, value);
    if (estimateBytes(candidate) <= maxBytes) {
      candidate.truncated = true;
      candidate.truncationReason = 'response_payload_budget_exceeded';
      candidate.originalBytes = originalBytes;
      candidate.maxPayloadBytes = maxBytes;
      const finalBytes = estimateBytes(candidate);
      return {
        payload: candidate,
        truncated: true,
        originalBytes,
        finalBytes
      };
    }
  }

  let loops = 0;
  while (estimateBytes(candidate) > maxBytes && loops < 6) {
    loops += 1;
    const keys = Object.keys(candidate).filter((key) => !ENVELOPE_KEYS.has(key));
    keys.sort((a, b) => estimateBytes(candidate[b]) - estimateBytes(candidate[a]));

    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === 'string') {
        candidate[key] = truncateText(value, Math.max(256, Math.floor(value.length / 2)));
      } else if (Array.isArray(value)) {
        candidate[key] = trimArray(value, Math.max(10, Math.floor(value.length / 2)));
      } else if (value && typeof value === 'object') {
        candidate[key] = trimObjectKeys(value, 20);
      }

      if (estimateBytes(candidate) <= maxBytes) break;
    }
  }

  if (estimateBytes(candidate) > maxBytes) {
    candidate = buildFallbackPayload(candidate, maxBytes, originalBytes);
  } else {
    candidate.truncated = true;
    candidate.truncationReason = 'response_payload_budget_exceeded';
    candidate.originalBytes = originalBytes;
    candidate.maxPayloadBytes = maxBytes;
    candidate.retryWith = candidate.retryWith || {
      detail: 'low',
      fullPage: false,
      maxItems: 80,
      limit: 20
    };
  }

  candidate = ensureFitsBudget(candidate, maxBytes, originalBytes);
  const finalBytes = estimateBytes(candidate);
  return {
    payload: candidate,
    truncated: true,
    originalBytes,
    finalBytes
  };
}

const OPENAI_ORG_COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const OPENAI_ORG_USAGE_COMPLETIONS_URL = 'https://api.openai.com/v1/organization/usage/completions';
const ORG_COSTS_CACHE_TTL_MS = 10 * 60 * 1000;
const ORG_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

const orgCostsCache = new Map();
const orgUsageCache = new Map();

function buildCacheKey(prefix, params) {
  return `${prefix}:${JSON.stringify(params || {})}`;
}

function normalizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractAmountUsd(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const amount = bucket.amount || bucket.total_amount || bucket.cost || bucket.costs;
  if (amount && typeof amount === 'object') {
    const candidate =
      normalizeNumber(amount.value) ??
      normalizeNumber(amount.usd) ??
      normalizeNumber(amount.amount) ??
      normalizeNumber(amount.total) ??
      null;
    if (candidate != null) return candidate;
  }
  return normalizeNumber(bucket.amount_usd ?? bucket.cost_usd ?? bucket.total_usd ?? bucket.total_cost);
}

function normalizeCostsBuckets(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .map((bucket) => {
      const amountUsd = extractAmountUsd(bucket);
      return {
        start_time: normalizeNumber(bucket?.start_time),
        end_time: normalizeNumber(bucket?.end_time),
        amount_usd: amountUsd,
        project_id: bucket?.project_id || bucket?.project || bucket?.group_by?.project_id || null
      };
    })
    .filter((bucket) => Number.isFinite(bucket.start_time) && Number.isFinite(bucket.end_time));
}

function sumUsageTokens(result) {
  const input =
    normalizeNumber(result?.input_tokens) ??
    normalizeNumber(result?.prompt_tokens) ??
    normalizeNumber(result?.inputTokens) ??
    null;
  const output =
    normalizeNumber(result?.output_tokens) ??
    normalizeNumber(result?.completion_tokens) ??
    normalizeNumber(result?.outputTokens) ??
    null;
  const total = normalizeNumber(result?.total_tokens ?? result?.totalTokens);
  return {
    inputTokens: input ?? (total != null ? total : 0),
    outputTokens: output ?? 0,
    hasBreakdown: input != null || output != null
  };
}

function normalizeUsageBuckets(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .map((bucket) => {
      const results = Array.isArray(bucket?.results) ? bucket.results : [];
      let inputTokens = 0;
      let outputTokens = 0;
      let sawBreakdown = false;
      results.forEach((result) => {
        const { inputTokens: input, outputTokens: output, hasBreakdown } = sumUsageTokens(result);
        inputTokens += input || 0;
        outputTokens += output || 0;
        if (hasBreakdown) sawBreakdown = true;
      });
      if (!results.length) {
        const { inputTokens: input, outputTokens: output } = sumUsageTokens(bucket);
        inputTokens += input || 0;
        outputTokens += output || 0;
      }
      return {
        start_time: normalizeNumber(bucket?.start_time),
        end_time: normalizeNumber(bucket?.end_time),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        has_breakdown: sawBreakdown
      };
    })
    .filter((bucket) => Number.isFinite(bucket.start_time) && Number.isFinite(bucket.end_time));
}

function buildOrgQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry === undefined || entry === null || entry === '') return;
        query.append(`${key}[]`, String(entry));
      });
      return;
    }
    query.append(key, String(value));
  });
  return query.toString();
}

function buildAdminAuthHeaders(adminKey) {
  return { Authorization: `Bearer ${adminKey}` };
}

async function fetchOrgCosts({
  adminKey,
  start_time,
  end_time,
  bucket_width = '1d',
  group_by = ['project_id'],
  project_ids,
  limit
} = {}) {
  if (!adminKey) {
    return { ok: false, errorType: 'missing_key', message: 'Нужен Admin API Key для Organization Costs API.' };
  }
  const cacheKey = buildCacheKey('costs', {
    start_time,
    end_time,
    bucket_width,
    group_by,
    project_ids,
    limit
  });
  const now = Date.now();
  const cached = orgCostsCache.get(cacheKey);
  if (cached && now - cached.updatedAt < ORG_COSTS_CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  const query = buildOrgQuery({ start_time, end_time, bucket_width, group_by, project_ids, limit });
  const url = `${OPENAI_ORG_COSTS_URL}?${query}`;

  try {
    const response = await fetch(url, { headers: buildAdminAuthHeaders(adminKey) });
    if (!response.ok) {
      const errorText = await response.text();
      const errorPayload = (() => {
        try {
          return JSON.parse(errorText);
        } catch (error) {
          return null;
        }
      })();
      let message =
        errorPayload?.error?.message ||
        errorPayload?.message ||
        errorText ||
        `Organization costs request failed (${response.status}).`;
      if (response.status === 401 || response.status === 403) {
        message = 'Нужен Admin API Key (read-only) для Organization Costs API.';
      } else if (response.status === 429) {
        message = 'Превышен лимит запросов к Organization Costs API.';
      }
      if ((response.status === 429 || response.status >= 500) && cached) {
        return { ...cached, cached: true, warning: message };
      }
      return {
        ok: false,
        status: response.status,
        errorType: response.status === 401 || response.status === 403 ? 'unauthorized' : 'request_failed',
        message
      };
    }
    const payload = await response.json();
    const buckets = normalizeCostsBuckets(payload);
    const result = { ok: true, buckets, updatedAt: now };
    orgCostsCache.set(cacheKey, result);
    return result;
  } catch (error) {
    if (cached) {
      return { ...cached, cached: true, warning: error?.message || String(error) };
    }
    return { ok: false, errorType: 'network', message: error?.message || String(error) };
  }
}

async function fetchOrgUsageCompletions({
  adminKey,
  start_time,
  end_time,
  bucket_width = '1h',
  group_by = ['project_id', 'model'],
  project_ids,
  models,
  limit,
  page
} = {}) {
  if (!adminKey) {
    return { ok: false, errorType: 'missing_key', message: 'Нужен Admin API Key для Organization Usage API.' };
  }
  const cacheKey = buildCacheKey('usage', {
    start_time,
    end_time,
    bucket_width,
    group_by,
    project_ids,
    models,
    limit,
    page
  });
  const now = Date.now();
  const cached = orgUsageCache.get(cacheKey);
  if (cached && now - cached.updatedAt < ORG_USAGE_CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  const query = buildOrgQuery({
    start_time,
    end_time,
    bucket_width,
    group_by,
    project_ids,
    models,
    limit,
    page
  });
  const url = `${OPENAI_ORG_USAGE_COMPLETIONS_URL}?${query}`;

  try {
    const response = await fetch(url, { headers: buildAdminAuthHeaders(adminKey) });
    if (!response.ok) {
      const errorText = await response.text();
      const errorPayload = (() => {
        try {
          return JSON.parse(errorText);
        } catch (error) {
          return null;
        }
      })();
      let message =
        errorPayload?.error?.message ||
        errorPayload?.message ||
        errorText ||
        `Organization usage request failed (${response.status}).`;
      if (response.status === 401 || response.status === 403) {
        message = 'Нужен Admin API Key (read-only) для Organization Usage API.';
      } else if (response.status === 429) {
        message = 'Превышен лимит запросов к Organization Usage API.';
      }
      if ((response.status === 429 || response.status >= 500) && cached) {
        return { ...cached, cached: true, warning: message };
      }
      return {
        ok: false,
        status: response.status,
        errorType: response.status === 401 || response.status === 403 ? 'unauthorized' : 'request_failed',
        message
      };
    }
    const payload = await response.json();
    const buckets = normalizeUsageBuckets(payload);
    const result = { ok: true, buckets, updatedAt: now };
    orgUsageCache.set(cacheKey, result);
    return result;
  } catch (error) {
    if (cached) {
      return { ...cached, cached: true, warning: error?.message || String(error) };
    }
    return { ok: false, errorType: 'network', message: error?.message || String(error) };
  }
}

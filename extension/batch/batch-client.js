(function initBatchClient() {
  if (globalThis.ntBatchClient) return;

  const DEFAULT_COMPLETION_WINDOW = '24h';

  const buildHeaders = ({ apiKey, openAiOrganization, openAiProject }) => {
    const headers = {
      Authorization: `Bearer ${apiKey}`
    };
    if (openAiOrganization) {
      headers['OpenAI-Organization'] = openAiOrganization;
    }
    if (openAiProject) {
      headers['OpenAI-Project'] = openAiProject;
    }
    return headers;
  };

  const getBaseUrl = (apiBaseUrl) => {
    if (!apiBaseUrl) return 'https://api.openai.com/v1';
    try {
      const parsed = new URL(apiBaseUrl);
      if (parsed.pathname.includes('/v1/')) {
        return `${parsed.origin}/v1`;
      }
      return `${parsed.origin}/v1`;
    } catch (error) {
      if (apiBaseUrl.includes('/v1/')) {
        return apiBaseUrl.split('/v1/')[0] + '/v1';
      }
      return 'https://api.openai.com/v1';
    }
  };

  const uploadBatchFile = async (jsonlText, config) => {
    const baseUrl = getBaseUrl(config?.apiBaseUrl);
    const headers = buildHeaders(config || {});
    const form = new FormData();
    const blob = new Blob([jsonlText], { type: 'application/jsonl' });
    form.append('purpose', 'batch');
    form.append('file', blob, 'batch.jsonl');
    const response = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers,
      body: form
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.error?.message || 'Batch file upload failed');
      error.status = response.status;
      error.payload = body;
      throw error;
    }
    return body;
  };

  const createBatch = async (inputFileId, endpoint, config) => {
    const baseUrl = getBaseUrl(config?.apiBaseUrl);
    const headers = {
      ...buildHeaders(config || {}),
      'Content-Type': 'application/json'
    };
    const response = await fetch(`${baseUrl}/batches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input_file_id: inputFileId,
        endpoint,
        completion_window: DEFAULT_COMPLETION_WINDOW
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.error?.message || 'Batch creation failed');
      error.status = response.status;
      error.payload = body;
      throw error;
    }
    return body;
  };

  const pollBatch = async (batchId, config) => {
    const baseUrl = getBaseUrl(config?.apiBaseUrl);
    const headers = buildHeaders(config || {});
    const response = await fetch(`${baseUrl}/batches/${batchId}`, {
      method: 'GET',
      headers
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.error?.message || 'Batch poll failed');
      error.status = response.status;
      error.payload = body;
      throw error;
    }
    return body;
  };

  const downloadOutput = async (fileId, config) => {
    const baseUrl = getBaseUrl(config?.apiBaseUrl);
    const headers = buildHeaders(config || {});
    const response = await fetch(`${baseUrl}/files/${fileId}/content`, {
      method: 'GET',
      headers
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error('Batch output download failed');
      error.status = response.status;
      error.payload = text;
      throw error;
    }
    return text;
  };

  globalThis.ntBatchClient = {
    getBaseUrl,
    uploadBatchFile,
    createBatch,
    pollBatch,
    downloadOutput
  };
})();

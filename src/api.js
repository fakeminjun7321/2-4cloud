export async function api(path, options = {}) {
  // Bound read requests, including response-body stalls. Never automatically
  // retry a write: the server may already have persisted the submitted data.
  const { timeoutMs = (options.method || 'GET').toUpperCase() === 'GET' ? 20000 : 0, ...init } = options;
  const controller = new AbortController();
  const cancel = () => controller.abort(init.signal.reason);
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = timeoutMs ? setTimeout(() => controller.abort(new DOMException('Read timeout', 'TimeoutError')), timeoutMs) : null;
  try {
    const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init, signal: controller.signal });
    let result;
    try {
      result = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error('서버 응답을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.');
    }
    if (!response.ok) {
      const detail = result?.detail;
      throw new Error(typeof detail === 'string' ? detail : '요청을 처리하지 못했어요.');
    }
    if (!result || typeof result !== 'object') throw new Error('서버 응답을 확인할 수 없어요.');
    return result;
  } catch (error) {
    if (controller.signal.reason?.name === 'TimeoutError') {
      throw new Error('서버 응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', cancel);
  }
}

export function jsonRequest(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

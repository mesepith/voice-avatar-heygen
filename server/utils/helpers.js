//This file contains general-purpose helper functions used across the application.

export function nowIso(dt) {
  // Convert ms epoch to MySQL DATETIME (UTC)
  const d = new Date(dt);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} `
     + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

}

export async function timeIt(asyncFn) {
  const started = Date.now();
  try {
    const result = await asyncFn();
    const finished = Date.now();
    return { ok: true, result, elapsed_ms: finished - started, started_at: nowIso(started), finished_at: nowIso(finished) };
  } catch (error) {
    const finished = Date.now();
    error._timing = { elapsed_ms: finished - started, started_at: nowIso(started), finished_at: nowIso(finished) };
    throw error;
  }
}

// Normalize OpenAI (and fetch) errors to a consistent shape
export function normalizeOpenAIError(err) {
  return {
    http_status_code: err?.status ?? 500,
    error_code: err?.code ?? err?.error?.code ?? null,
    error_type: err?.type ?? err?.error?.type ?? null,
    error_param: err?.param ?? err?.error?.param ?? null,
    error_message: err?.error?.message ?? err?.message ?? 'Unknown error',
    request_id: err?.requestID ?? null,
    response_payload: err?.response ?? null,
    stack_trace: err?.stack ?? null
  };
}

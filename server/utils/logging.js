//All database logging functions are centralized here.

import db from '../config/db.js';

//buildOpenAIRequestMeta and buildOpenAIResponseMeta function Improve what we store in request_payload / response_payload 
export function buildOpenAIRequestMeta(messages, extra = {}) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  return {
    ...extra,
    message_count: messages.length,
    last_user_preview: lastUser.slice(0, 160)
  };
}

export function buildOpenAIResponseMeta(response) {
  const choice = response?.choices?.[0];
  const txt = choice?.message?.content || '';
  return {
    id: response?.id,
    model: response?.model,
    finish_reason: choice?.finish_reason || null,
    content_preview: txt.slice(0, 160)
  };
}


// Log any third-party API error (OpenAI, HeyGen, Deepgram, etc.)
export async function logThirdPartyError({
  service_by,
  provider_endpoint,
  chat_session_id = null,
  http_status_code = null,
  error_code = null,
  error_type = null,
  error_param = null,
  error_message = null,
  request_id = null,
  request_payload = null,
  response_payload = null,
  stack_trace = null,
  elapsed_ms = null,
  started_at = null,
  finished_at = null
}) {
  try {
    await db.execute(
      `INSERT INTO \`third_party_api_error_log\`
       (service_by, provider_endpoint, chat_session_id, http_status_code, error_code, error_type, error_param, error_message, request_id,
        request_payload, response_payload, stack_trace, elapsed_ms, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?, ?, NOW())`,
      [
        service_by, provider_endpoint, chat_session_id, http_status_code, error_code, error_type, error_param, error_message, request_id,
        JSON.stringify(request_payload ?? {}), JSON.stringify(response_payload ?? {}), stack_trace, elapsed_ms, started_at, finished_at
      ]
    );
  } catch (dbErr) {
    console.error("!!! FAILED to log third-party error:", dbErr?.message);
  }
}

// Helper function to log all HeyGen API calls to the database
export async function logHeygenApiCall({
  chat_session_id,
  heygen_api_endpoint,
  http_status_code,
  request_payload,
  response_payload,
  notes = '',
  elapsed_ms = null,
  started_at = null,
  finished_at = null
}) {
  if (!chat_session_id || !heygen_api_endpoint) {
    console.error("!!! logHeygenApiCall: Missing required fields (chat_session_id, heygen_api_endpoint)");
    return;
  }
  try {
    await db.execute(
      `INSERT INTO \`heygen_api_log\`
       (chat_session_id, heygen_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at, request_payload, response_payload, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        chat_session_id, heygen_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at,
        JSON.stringify(request_payload || {}), JSON.stringify(response_payload || {}), notes
      ]
    );
    console.log(`✓ Logged HeyGen API call for session ${chat_session_id}: ${heygen_api_endpoint}`);
  } catch (dbError) {
    console.error(`!!! FAILED to log HeyGen API call for session ${chat_session_id}:`, dbError.message);
  }
}

//Deepgram logger
export async function logDeepgramApiCall({
  chat_session_id,
  deepgram_api_endpoint,
  http_status_code = null,
  elapsed_ms = null,
  started_at = null,
  finished_at = null,
  request_payload = null,
  response_payload = null,
  notes = ''
}) {
  try {
    await db.execute(
      `INSERT INTO \`deepgram_api_log\`
       (chat_session_id, deepgram_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at, request_payload, response_payload, notes)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?)`,
      [
        chat_session_id, deepgram_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at,
        JSON.stringify(request_payload || {}), JSON.stringify(response_payload || {}), notes
      ]
    );
  } catch (e) {
    console.error("!!! FAILED to log Deepgram event:", e.message);
  }
}

// Helper function to log all OpenAI API calls to the database
export async function logOpenaiApiCall({
  chat_session_id,
  openai_api_endpoint = 'chat.completions',
  http_status_code = 200,
  elapsed_ms = null,
  started_at = null,
  finished_at = null,
  model = null,
  usage = {},
  request_payload = null,
  response_payload = null,
  notes = '',
  table_name = null,
  table_id = null
}) {
  try {
    const [res] = await db.execute(
      `INSERT INTO \`openai_api_log\`
       (chat_session_id, openai_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at, model,
        prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, request_payload, response_payload, notes, table_name, table_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), ?, ?, ?)`,
      [
        chat_session_id, openai_api_endpoint, http_status_code, elapsed_ms, started_at, finished_at, model,
        usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, usage?.completion_tokens_details?.reasoning_tokens ?? null, usage?.total_tokens ?? null,
        JSON.stringify(request_payload || {}), JSON.stringify(response_payload || {}), notes, table_name, table_id
      ]
    );
    return res.insertId;
  } catch (e) {
    console.error('!!! FAILED to log OpenAI call:', e.message);
    return null;
  }
}

//Add a helper to update back-links on the log row
export async function updateOpenaiLogLink(log_id, table_name, table_id) {
  if (!log_id || !table_name || !table_id) return;
  try {
    await db.execute(
      'UPDATE `openai_api_log` SET `table_name` = ?, `table_id` = ? WHERE `log_id` = ?',
      [table_name, table_id, log_id]
    );
  } catch (e) {
    console.error('!!! FAILED to update openai_api_log link:', e.message);
  }
}
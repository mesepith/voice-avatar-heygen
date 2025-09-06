//this file groups all the HeyGen-specific API endpoints.
import express from "express";
import { logHeygenApiCall, logThirdPartyError } from '../utils/logging.js';
import { timeIt } from '../utils/helpers.js';

const router = express.Router();

router.post("/session", async (req, res) => { 
  let sessionIdForLogging = 'UNKNOWN';
  try { 
    const { avatar_id, voice_id } = req.body; 
    const requestBodyNew = { version: "v2", avatar_id, ...(voice_id ? { voice_id } : {}) };

    const timedNew = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.new", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` },
      body: JSON.stringify(requestBodyNew)
    }));

    const rNew = timedNew.result;
    const newJson = await rNew.json();
    const d = newJson?.data;
    sessionIdForLogging = d?.session_id || 'UNKNOWN';

    await logHeygenApiCall({
      chat_session_id: sessionIdForLogging, heygen_api_endpoint: 'streaming.new', http_status_code: rNew.status,
      request_payload: requestBodyNew, response_payload: newJson, notes: rNew.ok ? 'Session created.' : 'Failed to create session.',
      elapsed_ms: timedNew.elapsed_ms, started_at: timedNew.started_at, finished_at: timedNew.finished_at
    });

    if (!rNew.ok) {
      await logThirdPartyError({
        service_by: 'heygen', provider_endpoint: 'streaming.new', chat_session_id: sessionIdForLogging, http_status_code: rNew.status,
        error_message: (newJson && newJson.error) ? JSON.stringify(newJson.error) : 'Non-200 response',
        request_payload: requestBodyNew, response_payload: newJson, elapsed_ms: timedNew.elapsed_ms,
        started_at: timedNew.started_at, finished_at: timedNew.finished_at
      });
    }

    if (!d?.url || !d?.access_token || !d?.session_id) { 
      console.error("Unexpected HeyGen response", newJson); 
      return res.status(500).json({ error: "HeyGen session: missing url/token/session_id" }); 
    } 

    const requestBodyStart = { session_id: d.session_id };
    const timedStart = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` },
      body: JSON.stringify(requestBodyStart)
    }));

    const rStart = timedStart.result;
    await logHeygenApiCall({
      chat_session_id: d.session_id, heygen_api_endpoint: 'streaming.start', http_status_code: rStart.status,
      request_payload: requestBodyStart, response_payload: {}, notes: rStart.ok ? 'Session start command sent.' : 'Failed to send start command.',
      elapsed_ms: timedStart.elapsed_ms, started_at: timedStart.started_at, finished_at: timedStart.finished_at
    });

    if (!rStart.ok) {
      await logThirdPartyError({
        service_by: 'heygen', provider_endpoint: 'streaming.start', chat_session_id: d.session_id, http_status_code: rStart.status,
        error_message: 'Non-200 from streaming.start', request_payload: requestBodyStart, response_payload: {},
        elapsed_ms: timedStart.elapsed_ms, started_at: timedStart.started_at, finished_at: timedStart.finished_at
      });
    }

    res.json({ session_id: d.session_id, url: d.url, access_token: d.access_token }); 
  } catch (e) { 
    console.error(e); 
    await logHeygenApiCall({
        chat_session_id: sessionIdForLogging, heygen_api_endpoint: 'streaming.session', http_status_code: 500,
        request_payload: req.body, response_payload: { error: e.message }, notes: 'Endpoint failed due to an exception.'
    });
    res.status(500).json({ error: "Failed to create/start HeyGen session" }); 
  } 
});

router.post("/interrupt", async (req, res) => { 
  const { session_id } = req.body;
  try { 
    const timed = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.interrupt", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify({ session_id }) 
    }));

    const r = timed.result;
    const data = await r.json().catch(() => ({})); 
    
    await logHeygenApiCall({
      chat_session_id: session_id, heygen_api_endpoint: 'streaming.interrupt', http_status_code: r.status,
      request_payload: { session_id }, response_payload: data, notes: r.ok ? 'Interrupt successful.' : 'Interrupt failed.',
      elapsed_ms: timed.elapsed_ms, started_at: timed.started_at, finished_at: timed.finished_at
    });

    if (!r.ok) {
      await logThirdPartyError({
        service_by: 'heygen', provider_endpoint: 'streaming.interrupt', chat_session_id: session_id,
        http_status_code: r.status, error_message: JSON.stringify(data), request_payload: { session_id },
        response_payload: data, elapsed_ms: timed.elapsed_ms, started_at: timed.started_at, finished_at: timed.finished_at
      });
    }

    res.status(r.ok ? 200 : 500).json(data); 
  } catch (e) { 
    console.error(e); 
    await logThirdPartyError({
      service_by: 'heygen', provider_endpoint: 'streaming.interrupt', chat_session_id: session_id,
      http_status_code: 500, error_message: e?.message || 'Exception in streaming.interrupt',
      request_payload: { session_id }
    });
    res.status(500).json({ error: "Failed to interrupt" }); 
  } 
});

router.post("/stop", async (req, res) => { 
  const { session_id } = req.body;
  try { 
    const timed = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.stop", { 
      method: "POST", 
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HEYGEN_API_KEY}` }, 
      body: JSON.stringify({ session_id }) 
    }));

    const r = timed.result;
    const data = await r.json().catch(() => ({})); 
    
    await logHeygenApiCall({
      chat_session_id: session_id, heygen_api_endpoint: 'streaming.stop', http_status_code: r.status,
      request_payload: { session_id }, response_payload: data, notes: r.ok ? 'Session stopped successfully.' : 'Session stop failed.',
      elapsed_ms: timed.elapsed_ms, started_at: timed.started_at, finished_at: timed.finished_at
    });

    if (!r.ok) {
      await logThirdPartyError({
        service_by: 'heygen', provider_endpoint: 'streaming.stop', chat_session_id: session_id,
        http_status_code: r.status, error_message: JSON.stringify(data), request_payload: { session_id },
        response_payload: data, elapsed_ms: timed.elapsed_ms, started_at: timed.started_at, finished_at: timed.finished_at
      });
    }

    res.status(r.ok ? 200 : 500).json(data); 
  } catch (e) { 
    console.error(e); 
    await logThirdPartyError({
      service_by: 'heygen', provider_endpoint: 'streaming.stop', chat_session_id: session_id,
      http_status_code: 500, error_message: e?.message || 'Exception in streaming.stop',
      request_payload: { session_id }
    });
    res.status(500).json({ error: "Failed to stop session" }); 
  } 
});

export default router;
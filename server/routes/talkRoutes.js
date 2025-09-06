//
// server/routes/talkRoutes.js
//
import express from "express";
import db from '../config/db.js';
import { planReply, generateChatTitle } from '../services/openAIService.js';
import { updateOpenaiLogLink, logHeygenApiCall, logThirdPartyError } from '../utils/logging.js';
import { timeIt } from '../utils/helpers.js';

const router = express.Router();

router.post("/", async (req, res) => {
  const { userText, session_id: chat_session_id } = req.body;
  if (!userText || !chat_session_id) {
    return res.status(400).json({ error: "userText and session_id required" });
  }

  try {
    const guest_id = chat_session_id;
    const [rows] = await db.execute(
        'SELECT user_message, ai_response FROM `chats` WHERE `chat_session_id` = ? ORDER BY `created_at` ASC',
        [chat_session_id]
    );
    const history = rows.flatMap(row => [
        { role: 'user', content: row.user_message },
        { role: 'assistant', content: row.ai_response }
    ]).filter(msg => msg.content);
    const isFirstMessage = history.length === 0;

    const { speech_text, hindi_line, ui_action, tokens, model, openai_log_id } = await planReply(userText, history, chat_session_id);

    const [insertResult] = await db.execute(
      `INSERT INTO \`chats\`
      (guest_id, chat_session_id, user_message, ai_response, has_image, ai_model, service_by,
        prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, openai_api_log_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        guest_id, chat_session_id, userText, speech_text, 0, model || 'gpt-5-chat-latest', 'open_ai',
        tokens?.prompt_tokens, tokens?.completion_tokens, tokens?.reasoning_tokens, tokens?.total_tokens, openai_log_id || null
      ]
    );
    const newChatId = insertResult.insertId;

    if (openai_log_id && newChatId) {
      await updateOpenaiLogLink(openai_log_id, 'chats', newChatId);
    }

    if (isFirstMessage && newChatId) {
      const { title, openai_log_id: title_log_id } = await generateChatTitle(userText, chat_session_id);
      if (title) {
        const [r] = await db.execute(
          'INSERT INTO `chats_title` (chat_id, chat_session_id, title, openai_api_log_id, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
          [newChatId, chat_session_id, title, title_log_id || null]
        );
        const newTitleId = r.insertId;
        if (title_log_id && newTitleId) {
          await updateOpenaiLogLink(title_log_id, 'chats_title', newTitleId);
        }
        console.log(`Saved new chat title for session ${chat_session_id}`);
      }
    }

    // Send the AI's response text to HeyGen
    try {
      const requestBody = { session_id: chat_session_id, task_type: "repeat", text: speech_text };
      const timedTask = await timeIt(() => fetch("https://api.heygen.com/v1/streaming.task", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.HEYGEN_API_KEY}` },
        body: JSON.stringify(requestBody)
      }));
      
      const r = timedTask.result;
      const responseText = await r.text();

      await logHeygenApiCall({
        chat_session_id, heygen_api_endpoint: 'streaming.task', http_status_code: r.status,
        request_payload: requestBody, response_payload: { data: responseText },
        notes: r.ok ? 'Successfully sent text to HeyGen.' : 'Failed to send text to HeyGen.',
        elapsed_ms: timedTask.elapsed_ms, started_at: timedTask.started_at, finished_at: timedTask.finished_at
      });

      if (!r.ok) {
        console.error("HeyGen task error:", r.status, responseText);
        await logThirdPartyError({
          service_by: 'heygen', provider_endpoint: 'streaming.task', chat_session_id, http_status_code: r.status,
          error_message: responseText || 'Non-200 from streaming.task', request_payload: requestBody,
          response_payload: { data: responseText }, elapsed_ms: timedTask.elapsed_ms,
          started_at: timedTask.started_at, finished_at: timedTask.finished_at
        });
      } else {
        console.log("Successfully sent text to HeyGen for speaking.");
      }
    } catch (e) {
      console.error("HeyGen call failed:", e);
    }
    
    res.json({ spoke: speech_text, ui: ui_action, hindi_line: hindi_line });

  } catch (e) {
    console.error("Talk endpoint failed:", e);
    await logThirdPartyError({
      service_by: 'heygen', provider_endpoint: 'streaming.task', chat_session_id, http_status_code: 500,
      error_message: e?.message || 'Exception in streaming.task',
      request_payload: { session_id: chat_session_id, task_type: "repeat" }
    });
    res.status(500).json({ error: "talk failed" });
  }
});

export default router;
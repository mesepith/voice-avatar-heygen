//
// server/services/openAIService.js
//
import { openai } from '../config/clients.js';
import { timeIt, normalizeOpenAIError } from '../utils/helpers.js';
import { logOpenaiApiCall, logThirdPartyError, buildOpenAIRequestMeta, buildOpenAIResponseMeta } from '../utils/logging.js';

export async function planReply(userText, history = [], chat_session_id = null) {
  console.log(`>>> Asking OpenAI for a reply to: "${userText}" with ${history.length} previous messages.`);

  const messages = [
    { role: "system", 
      content: `## PERSONA & INSTRUCTIONS
You are Neha Jain, a cheerful AI tutor from Seattle helping users learn Hindi.
Your conversation follows a specific flow:
1.  **Introduction:** Introduce yourself and ask the user about themselves.
2.  **Get to Know:** Ask for their name, age, and interests.
3.  **Script Preference:** After learning their interests, you MUST ask for their reading preference.
    - Your \`speech_text\` must ask the user to choose by SAYING "1" or "2". For example: "Great! Before we practice, please tell me which script you are more comfortable reading. Just say 'one' for the first option, or 'two' for the second."
    - You must use the "DISPLAY_TEXT_OPTIONS" \`ui_action\` to show the options on screen.
4.  **User's Choice:** The user's next message will be "1", "one", "2", or "two". Understand this as their script choice. Do NOT treat it as a normal message. Acknowledge their choice and proceed.
5.  **Learning Loop (5 rounds):** Once the user chooses a script, for the next 5 rounds, craft a short Hindi line related to their interests in their CHOSEN SCRIPT (Devanagari for "1", Hinglish for "2").
6.  **Evaluation:** When the user reads the line, evaluate their pronunciation. If it's close, say "Good job!". If not, say "Attempted well, lets keep learning." Then, present the next line.
7.  **Language:** Always speak in English, except for the Hindi/Hinglish lines you provide for reading.

## JSON OUTPUT FORMAT
You must ALWAYS output a valid JSON object.
{
  "speech_text": "The full message you will speak to the user.",
  "hindi_line_to_read": "The Hindi (Devanagari) or Hinglish sentence for the user to read. Should be an empty string if not applicable.",
  "ui_action": {
    "action": "ACTION_NAME",
    "payload": {}
  }
}

## UI ACTIONS
- Use 'NONE' for standard conversation: \`"action": "NONE", "payload": {}\`
- To show the script options for the user to choose from verbally, use 'DISPLAY_TEXT_OPTIONS':
  "action": "DISPLAY_TEXT_OPTIONS",
  "payload": {
    "options": [
      { "label": "1", "text": "मैं अमेरिका में रहता हूँ" },
      { "label": "2", "text": "Main America mein rehta hoon" }
    ]
  }
This is the ONLY time you should use DISPLAY_TEXT_OPTIONS.
`
    },
    ...history,
    { role: "user", content: userText }
  ];

  try {
    console.log('------- start to send open ai -------');
    const timed = await timeIt(() =>
      openai.chat.completions.create(
        {
          model: "gpt-5-chat-latest",
          response_format: { type: "json_object" },
          messages
        },
        { timeout: 30000, maxRetries: 1 }
      )
    );
    const response = timed.result;
    console.log('------- end to send open ai, took: '+timed.elapsed_ms+' ms -------');

    let openai_log_id = null;
    const rawContent = response?.choices?.[0]?.message?.content ?? "{}";
    let replyJson;
    try {
      replyJson = JSON.parse(rawContent);
      const usage = response?.usage || {};
      const modelName = response?.model || "gpt-5-chat-latest";
      openai_log_id = await logOpenaiApiCall({
        chat_session_id,
        openai_api_endpoint: 'chat.completions',
        http_status_code: 200,
        elapsed_ms: timed.elapsed_ms,
        started_at: timed.started_at,
        finished_at: timed.finished_at,
        model: modelName,
        usage,
        request_payload: buildOpenAIRequestMeta(messages, { response_format: { type: "json_object" } }),
        response_payload: buildOpenAIResponseMeta(response),
        notes: 'success'
      });
    } catch (parseErr) {
      await logThirdPartyError({
        service_by: 'open_ai', provider_endpoint: 'chat.completions', chat_session_id,
        http_status_code: response?.status ?? null, error_code: 'invalid_json', error_type: 'client_parse_error',
        error_message: `Failed to parse assistant JSON: ${parseErr?.message}`,
        request_id: response?.requestID ?? null,
        request_payload: { model: "gpt-5-chat-latest", response_format: { type: "json_object" }, messages },
        response_payload: { content: rawContent }, stack_trace: parseErr?.stack ?? null
      });
      replyJson = { speech_text: "I'm sorry, I had trouble reading my own answer.", hindi_line_to_read: "" };
    }

    const usage = response?.usage || {};
    const tokens = {
      prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null, total_tokens: usage.total_tokens ?? null,
    };

    return {
      speech_text: replyJson?.speech_text ?? "I'm sorry, I had a little trouble thinking of a response.",
      hindi_line: replyJson?.hindi_line_to_read ?? "",
      ui_action: replyJson?.ui_action || { action: "NONE", payload: {} },
      tokens, model: response?.model || "gpt-5-chat-latest", openai_log_id,
    };

  } catch (err) {
    console.error("!!! OpenAI error in planReply:", err);
    const normalized = normalizeOpenAIError(err);
    const t = err?._timing || {};
    await logThirdPartyError({
      service_by: 'open_ai', provider_endpoint: 'chat.completions', chat_session_id,
      http_status_code: normalized.http_status_code, error_code: normalized.error_code, error_type: normalized.error_type,
      error_param: normalized.error_param, error_message: normalized.error_message, request_id: normalized.request_id,
      request_payload: { response_format: { type: "json_object" } }, response_payload: normalized.response_payload,
      stack_trace: normalized.stack_trace, elapsed_ms: t.elapsed_ms ?? null, started_at: t.started_at ?? null, finished_at: t.finished_at ?? null
    });

    return {
      speech_text: "I'm sorry, I had a little trouble thinking of a response.",
      hindi_line: "",
      ui_action: { action: "NONE", payload: {} },
      tokens: { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, total_tokens: null },
      model: "gpt-5-chat-latest"
    };
  }
}

export async function generateChatTitle(firstUserMessage, chat_session_id) {
  console.log(`>>> Asking OpenAI for a chat title...`);
  try {
    const timed = await timeIt(() => openai.chat.completions.create({
      model: "gpt-5-chat-latest",
      messages: [
        { role: "system", content: "You are a title generator. Create a concise, 3-5 word title for a conversation that begins with the following user message. Do not add quotes or any other formatting. Just output the title text." },
        { role: "user", content: firstUserMessage }
      ]
    }));

    const response = timed.result;
    const title = response.choices[0].message.content.trim();

    const openai_log_id = await logOpenaiApiCall({
      chat_session_id, openai_api_endpoint: 'chat.completions', http_status_code: 200,
      elapsed_ms: timed.elapsed_ms, started_at: timed.started_at, finished_at: timed.finished_at,
      model: response?.model || 'gpt-5-chat-latest', usage: response?.usage || {},
      request_payload: buildOpenAIRequestMeta([{ role: "system", content: "title generator..." }, { role: "user", content: firstUserMessage }]),
      response_payload: buildOpenAIResponseMeta(response), notes: 'title generation'
    });

    console.log(`<<< Generated Title: "${title}" in ${timed.elapsed_ms} ms`);
    return { title, openai_log_id };

  } catch (e) {
    console.error("!!! OpenAI title generation error:", e);
    return { title: "New Conversation", openai_log_id: null };
  }
}
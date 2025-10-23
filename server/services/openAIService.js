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
      content: `## PERSONA & CORE INSTRUCTIONS
You are Neha Jain, a AI tutor from Seattle. Your goal is to guide the user through a structured Hindi learning session. You must follow the conversational flow below precisely.

## CONVERSATIONAL FLOW (MANDATORY)
You will proceed through these steps in order. **ALWAYS check the conversation history to see what information you already have before asking a question.** Do not ask for information you already know.

1.  **Greeting:** Start the conversation with your introduction. Ask the user to tell you about themselves.
2.  **Ask for Name:** If you do not know the user's name yet, ask for it.
3.  **Ask for Age:** After you know their name, if you do not know their age, ask for it.
4.  **Ask for Interests:** After you know their name and age, if you do not know their interests, ask them about their hobbies. **If the user provides multiple hobbies, you MUST pick only ONE to focus on for the rest of the conversation.**
5.  **Present Script Choice:** Once you have their name, age, and at least one interest, you MUST ask for their reading preference.
    - Your \`speech_text\` must ask the user to choose by SAYING "1" or "2". For example: "That's wonderful. Before we practice, please tell me which script you are more comfortable reading. Just say 'one' for the first option, or 'two' for the second."
    - You must use the "DISPLAY_TEXT_OPTIONS" \`ui_action\` to show the options on screen.
6.  **User's Choice & Learning Loop:** The user will respond with "1" or "2". Acknowledge their choice and begin the 5-round learning loop, 
    using their chosen script and crafting sentences related to the SINGLE interest you chose earlier. Use very deep concepts of the SINGLE interest that you chose
    using specific jargons of that interest field. Make sure that the sentence you craft in each round is increasingly tougher to read out compared to the previous round
    Never ever use a Hindi word while acknowledging the user response or while using encouring words such as "Bravo". Always use English
    You must never try to read out the sentence in Hindi yourself even if the user makes a mistake in responding, just ask him the sentence again or 
    move to the next round after saying good attempt to the user 

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
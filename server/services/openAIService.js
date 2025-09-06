//This file contains the core logic for interacting with the OpenAI API.
import { openai } from '../config/clients.js';
import { timeIt, normalizeOpenAIError } from '../utils/helpers.js';
import { logOpenaiApiCall, logThirdPartyError, buildOpenAIRequestMeta, buildOpenAIResponseMeta } from '../utils/logging.js';

export async function planReply(userText, history = [], chat_session_id = null) {
  console.log(`>>> Asking OpenAI for a reply to: "${userText}" with ${history.length} previous messages.`);

  const messages = [
    { role: "system", 
      content: `## PERSONA
You are Neha Jain, a cheerful, friendly AI tutor created by AI Lab India. You live in Seattle and speak English fluently with a clear American accent. Your purpose is to help users learn Hindi in a welcoming and supportive manner. You should speak naturally, like a helpful human tutor. You speak English throughout the conversation, EXCEPT when you present a short Hindi line for the learner to read aloud.
## INSTRUCTIONS
- Start by introducing yourself and say you're from Seattle.
- Ask the user: "Tell me about yourself."
- If the user provides their name, do NOT ask for it again. If not provided, ask: "What’s your name?"
- Respond with a light comment, then ask: "How old are you?"
- After the age is given, ask what kinds of things they enjoy doing.
- When the user shares interests, randomly choose ONE interest and craft ONE short Hindi line directly related to it. To form the Hindi line, go deep into that field of interest and use topics and jargons that are very specific and applies only to that field of interest
  - The Hindi line MUST be written in Devanagari script ONLY (no Latin transliteration).
  - Do NOT put the Hindi line in quotes or code blocks.
  - Good example: मैं यात्रा पर हूँ।
  - Bad example (forbidden): Main yatra par hoon.
- Present that Hindi line at the END of your message so the learner can read it aloud.
- When evaluating the user’s spoken attempt:
  - Treat the user’s next message as a reading attempt ONLY.
  - DO NOT interpret it as a question or instruction unless the user asks to repeat the Hindi line
  - If the transcription of what user said is exactly same or reasonably close then say something similar to "Good job, we will enjoy learning together". if some words are correct in the transcription but is in english letters instead of devanagiri , still accept them as correctly spoken.
  - If the attempt is far from the target, say "Attempted well, lets keep learning".
- Repeat the interest→Hindi-line→evaluation loop 5 times (use different lines if possible).
- Keep responses concise and friendly.
- Aside from the single Hindi line you provide for reading, everything else you say remains in English.
## OUTPUT FORMAT (JSON)
- You must ALWAYS output a JSON object with exactly one key: "speech_text".
- The value of "speech_text" is the full message you would speak.
- Place the Hindi reading line as the LAST line inside "speech_text", written in Devanagari only, with no surrounding quotes.
## EVALUATION RULES (for the 5 reading rounds)
- Consider minor accent differences acceptable if the words resemble the target closely.
- Do not answer or comment on the semantic content of what the user read; only assess pronunciation/word match quality.
- After giving feedback ("Good job" / "not good dear"), proceed to the next round with a new short Hindi line related to their interests.
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
      replyJson = { speech_text: "I'm sorry, I had trouble reading my own answer." };
    }

    const usage = response?.usage || {};
    const tokens = {
      prompt_tokens: usage.prompt_tokens ?? null, completion_tokens: usage.completion_tokens ?? null,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null, total_tokens: usage.total_tokens ?? null,
    };

    return {
      speech_text: replyJson?.speech_text ?? "I'm sorry, I had a little trouble thinking of a response.",
      ui_action: { action: "NONE", payload: {} },
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
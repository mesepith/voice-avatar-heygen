//This file initializes and exports all third-party API clients.
import dotenv from "dotenv";
import OpenAI from "openai";
import textToSpeech from "@google-cloud/text-to-speech";
import { createClient } from "@deepgram/sdk";

dotenv.config();

if (!process.env.OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); }
if (!process.env.DEEPGRAM_API_KEY) { console.error("!!! CRITICAL: Missing DEEPGRAM_API_KEY"); }
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`✓ GOOGLE_APPLICATION_CREDENTIALS is set to: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else {
    console.error("!!! CRITICAL: GOOGLE_APPLICATION_CREDENTIALS environment variable is not set!");
}

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export const ttsClient = new textToSpeech.TextToSpeechClient();
export const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
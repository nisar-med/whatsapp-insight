import { GoogleGenAI } from '@google/genai';
import { NextResponse } from 'next/server';

type ChatMessage = {
  remoteJid: string;
  pushName: string;
  text: string;
  timestamp: number;
};

type AskAiRequest = {
  sid?: string;
  query?: string;
  messages?: ChatMessage[];
};

const MODEL = 'gemini-3-flash-preview';
const MAX_MESSAGES = 500;
const SESSION_ID_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const rateLimitStore =
  ((globalThis as { __waAiRateLimitStore?: Map<string, RateLimitBucket> }).__waAiRateLimitStore ??=
    new Map<string, RateLimitBucket>());

function validateSessionId(sid: string | undefined): sid is string {
  return typeof sid === 'string' && SESSION_ID_REGEX.test(sid);
}

function consumeRateLimit(sessionId: string) {
  const now = Date.now();
  const bucket = rateLimitStore.get(sessionId);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitStore.set(sessionId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  rateLimitStore.set(sessionId, bucket);
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'Gemini API key is not configured. Set GEMINI_API_KEY.' },
      { status: 500 },
    );
  }

  let payload: AskAiRequest;
  try {
    payload = (await request.json()) as AskAiRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const query = payload.query?.trim();
  if (!query) {
    return NextResponse.json({ error: 'Query is required.' }, { status: 400 });
  }

  const sessionId = payload.sid?.trim();
  if (!validateSessionId(sessionId)) {
    return NextResponse.json({ error: 'Unauthorized request.' }, { status: 401 });
  }

  const rateLimit = consumeRateLimit(sessionId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again shortly.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(rateLimit.retryAfterSeconds),
        },
      },
    );
  }

  const messages = Array.isArray(payload.messages) ? payload.messages.slice(0, MAX_MESSAGES) : [];

  const context = messages
    .map((message) => {
      const timestampMs = Number.isFinite(message.timestamp) ? message.timestamp * 1000 : Date.now();
      const date = new Date(timestampMs).toLocaleString();
      const sender = (message.pushName || message.remoteJid || 'Unknown').trim();
      const text = (message.text || '').trim();
      return `[${date}] ${sender}: ${text}`;
    })
    .join('\n');

  const prompt = `
You are an assistant that helps users understand their WhatsApp messages.
Below is a list of recent messages from the user's WhatsApp.
Answer the user's question based ONLY on these messages.
If the information is not in the messages, say you don't know.

Recent Messages:
${context}

User Question: ${query}
`;

  try {
    const genAI = new GoogleGenAI({ apiKey });
    const result = await genAI.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
    });

    return NextResponse.json({ answer: result.text || 'No response generated.' });
  } catch (error) {
    console.error('AI Error:', error);
    return NextResponse.json(
      { error: 'Sorry, I encountered an error while processing your request.' },
      { status: 500 },
    );
  }
}
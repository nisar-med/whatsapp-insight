import { GoogleGenAI } from '@google/genai';
import { NextResponse } from 'next/server';

type ChatMessage = {
  remoteJid: string;
  pushName: string;
  text: string;
  timestamp: number;
};

type AskAiRequest = {
  query?: string;
  messages?: ChatMessage[];
};

const MODEL = 'gemini-3-flash-preview';
const MAX_MESSAGES = 500;

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
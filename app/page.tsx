'use client';

import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { GoogleGenAI } from "@google/genai";
import { 
  MessageSquare, 
  QrCode, 
  CheckCircle2, 
  XCircle, 
  Send, 
  Loader2, 
  Bot, 
  User,
  Search,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Initialize Gemini
const genAI = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY! });

interface Message {
  id: string;
  remoteJid: string;
  pushName: string;
  text: string;
  timestamp: number;
}

interface Chat {
  id: string;
  name?: string;
}

const SESSION_STORAGE_KEY = 'wa_insight_session_id';

function getOrCreateSessionId() {
  if (typeof window === 'undefined') return null;

  const existing = localStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;

  const newSessionId = window.crypto?.randomUUID
    ? window.crypto.randomUUID().replace(/-/g, '_')
    : `sid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  localStorage.setItem(SESSION_STORAGE_KEY, newSessionId);
  return newSessionId;
}

export default function WhatsAppInsights() {
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'qr_timeout'>('disconnected');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [aiResponse, setAiResponse] = useState<string | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sid = getOrCreateSessionId();
    if (!sid) return;

    setSessionId(sid);

    // Connect to the server
    const socket = io({ auth: { sid } });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server');
      setStatus('connecting');
    });

    socket.on('whatsapp:status', (newStatus: 'connected' | 'disconnected' | 'qr_timeout') => {
      setStatus(newStatus);
      if (newStatus === 'connected') setQrCode(null);
    });

    socket.on('whatsapp:qr', (qr: string) => {
      setQrCode(qr);
      setStatus('disconnected');
    });

    socket.on('whatsapp:new_message', (msg: Message) => {
      setMessages(prev => [msg, ...prev].slice(0, 1000));
    });

    socket.on('whatsapp:chats', (newChats: Chat[]) => {
      setChats(newChats);
    });

    // Initial fetch
    fetch(`/api/whatsapp/messages?sid=${encodeURIComponent(sid)}`)
      .then(res => res.json())
      .then(data => setMessages(data));

    fetch(`/api/whatsapp/status?sid=${encodeURIComponent(sid)}`)
      .then(res => res.json())
      .then(data => {
        if (data.status === 'connected') setStatus('connected');
        if (data.status === 'qr_timeout') setStatus('qr_timeout');
      });

    return () => {
      socket.disconnect();
    };
  }, []);

  const handleRetry = async () => {
    if (!sessionId) return;

    setStatus('connecting');
    setQrCode(null);
    try {
      await fetch(`/api/whatsapp/retry?sid=${encodeURIComponent(sessionId)}`, { method: 'POST' });
    } catch (error) {
      console.error('Retry failed:', error);
      setStatus('disconnected');
    }
  };

  const handleReset = async () => {
    if (!sessionId) return;
    if (!confirm('Are you sure you want to reset the session? This will disconnect your current WhatsApp account.')) return;
    
    setStatus('connecting');
    setQrCode(null);
    setMessages([]);
    setChats([]);
    try {
      await fetch(`/api/whatsapp/reset?sid=${encodeURIComponent(sessionId)}`, { method: 'POST' });
    } catch (error) {
      console.error('Reset failed:', error);
      setStatus('disconnected');
    }
  };

  const handleAskAi = async () => {
    if (!query.trim()) return;
    
    setIsAiLoading(true);
    setAiResponse(null);

    try {
      // Prepare context from messages
      const context = messages
        .map(m => `[${new Date(m.timestamp * 1000).toLocaleString()}] ${m.pushName || m.remoteJid}: ${m.text}`)
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

      const result = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ]
      });
      setAiResponse(result.text || "No response generated.");
    } catch (error) {
      console.error("AI Error:", error);
      setAiResponse("Sorry, I encountered an error while processing your request.");
    } finally {
      setIsAiLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f0f2f5] text-[#111b21] font-sans selection:bg-[#00a884]/30">
      {/* Header */}
      <header className="bg-[#00a884] text-white p-4 shadow-md flex justify-between items-center sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-white/20 p-2 rounded-full">
            <MessageSquare className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">WhatsApp Chat Insights</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm font-medium ${
            status === 'connected' ? 'bg-white/20' : 'bg-red-500/20'
          }`}>
            {status === 'connected' ? (
              <><CheckCircle2 className="w-4 h-4" /> Connected</>
            ) : status === 'connecting' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Connecting...</>
            ) : status === 'qr_timeout' ? (
              <><RefreshCw className="w-4 h-4" /> QR Timeout</>
            ) : (
              <><XCircle className="w-4 h-4" /> Disconnected</>
            )}
          </div>
          <button 
            onClick={handleReset}
            className="bg-white/10 hover:bg-white/20 p-2 rounded-full transition-colors"
            title="Reset Session"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Connection & Messages */}
        <div className="lg:col-span-5 space-y-6">
          {/* Connection Card */}
          <section className="bg-white rounded-2xl shadow-sm border border-black/5 overflow-hidden">
            <div className="p-6 border-b border-black/5 bg-gray-50/50">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <QrCode className="w-5 h-5 text-[#00a884]" />
                WhatsApp Connection
              </h2>
            </div>
            <div className="p-8 flex flex-col items-center justify-center min-h-[300px]">
              {status === 'connected' ? (
                <div className="text-center space-y-4">
                  <div className="w-20 h-20 bg-[#00a884]/10 rounded-full flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-10 h-10 text-[#00a884]" />
                  </div>
                  <div>
                    <p className="text-lg font-medium">Successfully Connected!</p>
                    <p className="text-sm text-gray-500">Your messages are being synced in real-time.</p>
                  </div>
                </div>
              ) : status === 'qr_timeout' ? (
                <div className="text-center space-y-4">
                  <div className="w-20 h-20 bg-amber-500/10 rounded-full flex items-center justify-center mx-auto">
                    <RefreshCw className="w-10 h-10 text-amber-500" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-lg font-medium">QR Code Expired</p>
                    <p className="text-sm text-gray-500">The connection attempt timed out. Please click below to generate a new QR code.</p>
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={handleRetry}
                      className="bg-[#00a884] text-white px-6 py-2 rounded-full font-medium hover:bg-[#008f70] transition-colors"
                    >
                      Retry Now
                    </button>
                  </div>
                </div>
              ) : qrCode ? (
                <div className="text-center space-y-6">
                  <div className="bg-white p-4 rounded-xl shadow-inner border border-gray-100 inline-block">
                    <img src={qrCode} alt="WhatsApp QR Code" className="w-64 h-64" />
                  </div>
                  <div className="space-y-2">
                    <p className="font-medium">Scan this QR code with WhatsApp</p>
                    <ol className="text-sm text-gray-500 text-left list-decimal list-inside space-y-1 max-w-xs mx-auto">
                      <li>Open WhatsApp on your phone</li>
                      <li>Tap Menu or Settings and select Linked Devices</li>
                      <li>Tap on Link a Device</li>
                      <li>Point your phone to this screen to capture the code</li>
                    </ol>
                  </div>
                </div>
              ) : (
                <div className="text-center space-y-4">
                  <Loader2 className="w-12 h-12 text-[#00a884] animate-spin mx-auto" />
                  <p className="text-gray-500">Initializing WhatsApp session...</p>
                </div>
              )}
            </div>
          </section>

          {/* Recent Messages Card */}
          <section className="bg-white rounded-2xl shadow-sm border border-black/5 flex flex-col h-[500px]">
            <div className="p-4 border-b border-black/5 bg-gray-50/50 flex justify-between items-center">
              <h2 className="font-semibold flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-[#00a884]" />
                Recent Messages
              </h2>
              <span className="text-xs font-mono text-gray-400 bg-gray-100 px-2 py-1 rounded">
                {messages.length} cached
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-2">
                  <Search className="w-8 h-8 opacity-20" />
                  <p className="text-sm">No messages synced yet</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={msg.id} 
                    className="p-3 bg-[#f0f2f5] rounded-lg border border-transparent hover:border-[#00a884]/20 transition-colors"
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-xs font-bold text-[#00a884] truncate max-w-[150px]">
                        {msg.pushName || msg.remoteJid.split('@')[0]}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {new Date(msg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-sm line-clamp-2 leading-relaxed">{msg.text}</p>
                  </motion.div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* Right Column: AI Assistant */}
        <div className="lg:col-span-7">
          <section className="bg-white rounded-2xl shadow-sm border border-black/5 flex flex-col h-full min-h-[600px]">
            <div className="p-6 border-b border-black/5 bg-gray-50/50 flex items-center gap-3">
              <div className="bg-[#00a884]/10 p-2 rounded-xl">
                <Bot className="w-6 h-6 text-[#00a884]" />
              </div>
              <div>
                <h2 className="text-lg font-bold">Chat Assistant</h2>
                <p className="text-xs text-gray-500 italic">Answers based on your synced messages</p>
              </div>
            </div>

            <div className="flex-1 p-6 overflow-y-auto space-y-6 custom-scrollbar">
              <AnimatePresence mode="wait">
                {aiResponse ? (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="space-y-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="bg-[#00a884] p-2 rounded-lg mt-1">
                        <Bot className="w-4 h-4 text-white" />
                      </div>
                      <div className="flex-1 bg-[#f0f2f5] p-5 rounded-2xl rounded-tl-none border border-black/5 shadow-sm">
                        <div className="prose prose-sm max-w-none text-[#111b21] leading-relaxed whitespace-pre-wrap">
                          {aiResponse}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ) : !isAiLoading && (
                  <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-40">
                    <Bot className="w-16 h-16" />
                    <div className="max-w-xs">
                      <p className="text-lg font-medium">Ask me anything!</p>
                      <p className="text-sm">&quot;What was the last thing John said?&quot; or &quot;Summarize my recent chats.&quot;</p>
                    </div>
                  </div>
                )}
              </AnimatePresence>

              {isAiLoading && (
                <div className="flex items-start gap-3">
                  <div className="bg-[#00a884] p-2 rounded-lg mt-1">
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 bg-[#f0f2f5] p-5 rounded-2xl rounded-tl-none border border-black/5 flex items-center gap-3">
                    <Loader2 className="w-4 h-4 animate-spin text-[#00a884]" />
                    <span className="text-sm text-gray-500">Analyzing your messages...</span>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-black/5 bg-gray-50/50">
              <div className="relative flex items-center gap-3">
                <div className="flex-1 relative">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAskAi()}
                    placeholder="Ask about your chats..."
                    className="w-full bg-white border border-black/10 rounded-xl px-5 py-4 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] transition-all shadow-inner"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">
                    <User className="w-4 h-4" />
                  </div>
                </div>
                <button
                  onClick={handleAskAi}
                  disabled={isAiLoading || !query.trim() || status !== 'connected'}
                  className="bg-[#00a884] hover:bg-[#008f70] disabled:opacity-50 disabled:cursor-not-allowed text-white p-4 rounded-xl transition-all shadow-lg active:scale-95 flex items-center justify-center"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
              {status !== 'connected' && (
                <p className="text-[10px] text-red-500 mt-2 text-center font-medium">
                  Connect WhatsApp to start asking questions
                </p>
              )}
            </div>
          </section>
        </div>
      </main>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #d1d7db;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #adb5bd;
        }
      `}</style>
    </div>
  );
}

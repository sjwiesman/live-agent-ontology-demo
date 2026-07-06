import { useState, useRef, useEffect } from 'react';
import { MessageCircle, Trash2, X, Send, ChevronDown, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useChat, ChatMessage, ThinkingEvent } from '../contexts/ChatContext';

const SUGGESTED_PROMPTS = [
  'What is happening at Worldport right now?',
  'Which packages should we act on first?',
  'Any vehicles that need maintenance?',
];

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncateContent(content: string | undefined, maxLength: number = 200): { text: string; truncated: boolean } {
  if (!content) return { text: '', truncated: false };
  if (content.length <= maxLength) return { text: content, truncated: false };
  return { text: content.slice(0, maxLength), truncated: true };
}

// Thinking indicator - shows tool calls in real-time
function ThinkingDisplay({ events, isLive }: { events: ThinkingEvent[]; isLive: boolean }) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (events.length === 0) return null;

  return (
    <div className={`text-xs space-y-1 ${isLive ? 'animate-pulse' : ''}`}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1 text-gray-400 hover:text-gray-300"
      >
        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{events.length} step{events.length !== 1 ? 's' : ''}</span>
      </button>
      {isExpanded && (
        <div className="space-y-1 pl-4 border-l border-gray-700">
          {events.map((event, idx) => (
            <div key={idx} className="flex items-start gap-2 text-gray-400">
              {event.type === 'tool_call' && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-amber-400">Calling</span>
                  <span className="font-mono text-yellow-300">{event.data.name}</span>
                  {event.data.args && Object.keys(event.data.args).length > 0 && (
                    (() => {
                      const argsStr = Object.entries(event.data.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
                      const { text, truncated } = truncateContent(argsStr, 100);
                      return (
                        <span className="text-gray-500">
                          ({text}{truncated && '...'})
                        </span>
                      );
                    })()
                  )}
                </div>
              )}
              {event.type === 'tool_result' && (
                <div className="flex items-start gap-1">
                  <span className="text-green-400 shrink-0">Result:</span>
                  <span className="text-gray-300 break-words">{event.data.content}</span>
                </div>
              )}
              {event.type === 'thinking' && (
                <span className="text-purple-400 italic break-words">{event.data.content}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const isUser = message.role === 'user';
  const showThinking = message.thinking && message.thinking.length > 0;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 ${
          isUser ? 'bg-amber-600 text-white' : 'bg-gray-800 text-gray-100'
        }`}
      >
        {!isUser && showThinking && (
          <div className="mb-2 pb-2 border-b border-gray-700">
            <ThinkingDisplay
              events={message.thinking!}
              isLive={isStreaming && message.status === 'streaming'}
            />
          </div>
        )}

        {message.status === 'streaming' && !message.content ? (
          <div className="flex items-center gap-2 text-gray-400">
            <div className="h-2 w-2 bg-amber-500 rounded-full animate-pulse" />
            <span>Thinking...</span>
          </div>
        ) : message.status === 'error' ? (
          <span className="text-red-400">{message.content}</span>
        ) : (
          <div className="text-sm prose prose-invert prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-headings:my-2 prose-pre:bg-gray-900 prose-pre:text-gray-100">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}

        <div className={`text-xs mt-1 ${isUser ? 'text-amber-200' : 'text-gray-500'}`}>
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

function ChatInput() {
  const { sendMessage, isStreaming } = useChat();
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (input.trim() && !isStreaming) {
      sendMessage(input);
      setInput('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
  };

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 p-3 border-t border-gray-700 items-end">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Ask the hub copilot..."
        disabled={isStreaming}
        rows={1}
        className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50 resize-none overflow-y-auto"
        style={{ minHeight: '40px', maxHeight: '150px' }}
      />
      <button
        type="submit"
        disabled={!input.trim() || isStreaming}
        className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium flex items-center gap-1 shrink-0"
      >
        <Send className="h-4 w-4" />
      </button>
    </form>
  );
}

function ChatPanelContent({
  isExpanded,
  onToggleExpand,
}: {
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const { messages, setIsOpen, isStreaming, clearMessages, currentThinking, threadId, sendMessage } = useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentThinking]);

  return (
    <div className="flex flex-col h-full bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0 bg-ups-brown">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-ups-gold" />
          <span className="font-medium text-white">Hub Operations Copilot</span>
          {isStreaming && <span className="h-2 w-2 bg-ups-gold rounded-full animate-pulse" />}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleExpand}
            className="p-1.5 hover:bg-gray-800 rounded transition-colors"
            title={isExpanded ? 'Collapse to panel' : 'Expand to full screen'}
          >
            {isExpanded ? (
              <Minimize2 className="h-4 w-4 text-gray-400 hover:text-amber-400" />
            ) : (
              <Maximize2 className="h-4 w-4 text-gray-400 hover:text-amber-400" />
            )}
          </button>
          <button
            onClick={clearMessages}
            className="p-1.5 hover:bg-gray-800 rounded transition-colors"
            title="Clear chat"
          >
            <Trash2 className="h-4 w-4 text-gray-400 hover:text-red-400" />
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 hover:bg-gray-800 rounded transition-colors"
            title="Close panel"
          >
            <X className="h-4 w-4 text-gray-400" />
          </button>
        </div>
      </div>

      {threadId && (
        <div className="px-3 py-1 bg-gray-800/50 text-xs text-gray-500 border-b border-gray-700 shrink-0">
          Session: <span className="font-mono">{threadId}</span>
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm gap-3">
            <MessageCircle className="h-12 w-12 opacity-50" />
            <p>Ask about packages, sortation equipment, alarms, or the fleet.</p>
            <div className="flex flex-col gap-2 w-full px-2">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => sendMessage(prompt)}
                  className="text-left text-xs px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-300 transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} isStreaming={isStreaming} />
            ))}
            {isStreaming && currentThinking.length > 0 && (
              <div className="bg-gray-800 rounded-lg px-3 py-2">
                <ThinkingDisplay events={currentThinking} isLive={true} />
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <ChatInput />
    </div>
  );
}

export default function ChatWidget() {
  const { messages, isOpen, setIsOpen, isExpanded, setIsExpanded } = useChat();

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isExpanded) {
        setIsExpanded(false);
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isExpanded, setIsExpanded]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 h-14 w-14 bg-amber-600 hover:bg-amber-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all z-50 hover:scale-105"
        title="Open Hub Operations Copilot"
      >
        <MessageCircle className="h-6 w-6" />
        {messages.length > 0 && (
          <span className="absolute -top-1 -right-1 h-5 w-5 bg-red-500 rounded-full text-xs flex items-center justify-center font-medium">
            {messages.length}
          </span>
        )}
      </button>
    );
  }

  if (isExpanded) {
    return (
      <>
        <div className="fixed inset-0 bg-black/60 z-50" onClick={() => setIsExpanded(false)} />
        <div className="fixed inset-4 md:inset-8 lg:inset-12 z-50 flex items-center justify-center">
          <div className="w-full h-full max-w-6xl">
            <ChatPanelContent isExpanded={true} onToggleExpand={() => setIsExpanded(false)} />
          </div>
        </div>
      </>
    );
  }

  // Floating panel anchored bottom-right
  return (
    <div className="fixed bottom-6 right-6 w-[420px] h-[600px] max-h-[80vh] z-50 shadow-2xl">
      <ChatPanelContent isExpanded={false} onToggleExpand={() => setIsExpanded(true)} />
    </div>
  );
}

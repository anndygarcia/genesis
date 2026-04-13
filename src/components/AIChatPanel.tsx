// AI Chat Panel component for Create Studio

import { useState, useRef, useEffect } from 'react'
import { Send, X, Sparkles, Loader2 } from 'lucide-react'
import { chatCompletion, isConfigured } from '../lib/openai'
import { AI_TOOLS, SYSTEM_PROMPT, summarizeToolCall, toolCallToObjects } from '../lib/ai-tools'
import type { AIContext } from '../lib/ai-context'
import { loadAIContext, addMessage, trimHistory, setLastAction, saveAIContext } from '../lib/ai-context'
import type { StudioObject } from '../lib/ai-tools'

interface AIChatPanelProps {
  isOpen: boolean
  onClose: () => void
  onExecuteTool: (toolCall: any) => void
  currentObjects: StudioObject[]
}

export default function AIChatPanel({ isOpen, onClose, onExecuteTool, currentObjects }: AIChatPanelProps) {
  const [context, setContext] = useState<AIContext>(loadAIContext)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const apiConfigured = isConfigured()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Update context with current design
    setContext(prev => {
      const next = { ...prev, currentDesign: currentObjects }
      saveAIContext(next)
      return next
    })
  }, [currentObjects])

  useEffect(() => {
    scrollToBottom()
  }, [context.conversationHistory])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const handleSend = async () => {
    if (!input.trim() || isLoading) return

    const userMessage = input.trim()
    setInput('')
    setIsLoading(true)

    // Add user message to history
    let updatedContext = addMessage(context, {
      role: 'user',
      content: userMessage,
    })

    // Trim history if too long
    if (updatedContext.conversationHistory.length > 20) {
      updatedContext = trimHistory(updatedContext, 15)
    }

    try {
      // Prepare messages with system prompt
      const messages = [
        { role: 'system' as const, content: SYSTEM_PROMPT },
        ...updatedContext.conversationHistory,
        {
          role: 'assistant' as const,
          content: `Current design has ${currentObjects.length} objects. You can add, modify, or delete objects using the available tools.`,
        },
      ]

      console.log('[AI Chat] Sending request with', messages.length, 'messages')

      // Call OpenAI API
      const response = await chatCompletion({
        messages,
        tools: AI_TOOLS,
        temperature: 0.7,
        maxTokens: 500,
      })

      console.log('[AI Chat] Response:', response)

      // Handle tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        console.log('[AI Chat] Tool calls:', response.toolCalls)
        for (const toolCall of response.toolCalls) {
          const objects = toolCallToObjects(toolCall)
          console.log('[AI Chat] Executing tool:', toolCall, '→', objects.length ? objects : '(non-object action)')
          onExecuteTool(toolCall)
          updatedContext = setLastAction(updatedContext, summarizeToolCall(toolCall))
        }
      }

      // Add assistant response
      updatedContext = addMessage(updatedContext, {
        role: 'assistant',
        content: response.content,
      })

      setContext(updatedContext)
    } catch (error) {
      console.error('[AI Chat] Error:', error)
      const errorMessage = error instanceof Error ? error.message : 'Failed to get response'
      console.error('[AI Chat] Error details:', errorMessage)
      
      updatedContext = addMessage(updatedContext, {
        role: 'assistant',
        content: `Sorry, I encountered an error: ${errorMessage}`,
      })
      setContext(updatedContext)
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const quickActions = [
    { label: 'Add a wall', prompt: 'Add a 4-meter wall at position [0, 1.3, 0]' },
    { label: 'Create room', prompt: 'Generate a 5x6 living room with modern style' },
    { label: 'Add door', prompt: 'Add a door at [2, 0, 0]' },
    { label: 'Clear design', prompt: 'Delete all objects' },
  ]

  if (!isOpen) return null

  return (
    <div className="fixed right-4 bottom-20 w-80 max-h-[calc(100vh-8rem)] z-30 flex flex-col">
      <div className="rounded-xl border border-white/10 bg-neutral-900/95 backdrop-blur-sm flex flex-col h-full shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#a588ef]" />
            <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">AI Assistant</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 hover:bg-white/10 text-neutral-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/10 text-[11px] text-neutral-400">
          <span className={apiConfigured ? 'text-emerald-300' : 'text-amber-300'}>
            {apiConfigured ? 'AI ready' : 'API key required'}
          </span>
          <span>{currentObjects.length} object{currentObjects.length === 1 ? '' : 's'}</span>
          <span className="truncate text-right">{context.lastAction || 'Ready for a design prompt'}</span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {!apiConfigured && (
            <div className="rounded-lg bg-yellow-900/20 border border-yellow-500/30 p-3 text-xs text-yellow-200">
              OpenAI API key not configured. Add VITE_OPENAI_API_KEY to your .env.local file.
            </div>
          )}

          {context.conversationHistory
            .filter(msg => msg.role !== 'system')
            .map((msg, idx) => (
              <div
                key={idx}
                className={`rounded-lg p-2.5 text-xs ${
                  msg.role === 'user'
                    ? 'bg-[#a588ef]/20 border border-[#a588ef]/30 text-white ml-8'
                    : 'bg-neutral-800/50 border border-white/10 text-neutral-200 mr-8'
                }`}
              >
                {msg.content}
              </div>
            ))}

          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Thinking...
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Actions */}
        <div className="px-3 py-2 border-t border-white/10">
          <div className="flex flex-wrap gap-1.5">
            {quickActions.map((action) => (
              <button
                key={action.label}
                onClick={() => setInput(action.prompt)}
                disabled={!apiConfigured || isLoading}
                className="rounded-md border border-white/10 bg-neutral-800/50 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700/50 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>

        {/* Input */}
        <div className="p-3 border-t border-white/10">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={apiConfigured ? 'Describe what you want to build...' : 'Configure API key first'}
              disabled={!apiConfigured || isLoading}
              className="flex-1 rounded-lg bg-neutral-800 border border-white/10 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-[#a588ef]/50 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || !apiConfigured || isLoading}
              className="rounded-lg bg-[#a588ef] hover:bg-[#a588ef]/80 p-2 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

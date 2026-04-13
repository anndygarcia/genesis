// OpenAI API client for Create Studio AI assistant

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: any
  }
}

export interface ChatCompletionOptions {
  messages: ChatMessage[]
  tools?: OpenAIToolDefinition[] | any[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
}

export interface ChatCompletionResponse {
  content: string
  toolCalls?: any[]
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

const API_KEY = import.meta.env.VITE_OPENAI_API_KEY
const MODEL = import.meta.env.VITE_OPENAI_MODEL || 'gpt-4o'
const MIN_REQUEST_INTERVAL_MS = 900

let lastRequestAt = 0

if (!API_KEY) {
  console.warn('[OpenAI] VITE_OPENAI_API_KEY not set. AI features will be disabled.')
}

/**
 * Simple in-memory cache for API responses to reduce costs
 */
const responseCache = new Map<string, ChatCompletionResponse>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function normalizeTools(tools?: any[]): OpenAIToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool, index) => {
    if (!tool || typeof tool !== 'object') {
      throw new Error(`[OpenAI] Tool at index ${index} is not an object`)
    }

    if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
      const fn = tool.function
      if (typeof fn.name !== 'string' || !fn.name.trim()) {
        throw new Error(`[OpenAI] Tool at index ${index} is missing a valid function.name`)
      }
      return {
        type: 'function',
        function: {
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : undefined,
          parameters: fn.parameters,
        },
      }
    }

    if (tool.type === 'function') {
      const name = typeof tool.name === 'string' ? tool.name.trim() : ''
      if (!name) {
        throw new Error(`[OpenAI] Tool at index ${index} is missing a valid name`)
      }
      return {
        type: 'function',
        function: {
          name,
          description: typeof tool.description === 'string' ? tool.description : undefined,
          parameters: tool.parameters,
        },
      }
    }

    throw new Error(`[OpenAI] Tool at index ${index} must be a function tool`)
  })
}

function getCacheKey(messages: ChatMessage[], tools?: any[]): string {
  return JSON.stringify({ messages, tools })
}

function getCachedResponse(key: string): ChatCompletionResponse | null {
  const cached = responseCache.get(key)
  if (!cached) return null
  
  // Check if cache is expired
  const timestamp = (cached as any).timestamp
  if (timestamp && Date.now() - timestamp > CACHE_TTL) {
    responseCache.delete(key)
    return null
  }
  
  return cached
}

function setCachedResponse(key: string, response: ChatCompletionResponse): void {
  (response as any).timestamp = Date.now()
  responseCache.set(key, response)
  
  // Limit cache size
  if (responseCache.size > 100) {
    const oldestKey = responseCache.keys().next().value
    if (oldestKey) {
      responseCache.delete(oldestKey)
    }
  }
}

/**
 * Send chat completion request to OpenAI API
 */
export async function chatCompletion(
  options: ChatCompletionOptions
): Promise<ChatCompletionResponse> {
  if (!API_KEY) {
    throw new Error('OpenAI API key not configured')
  }

  const { messages, tools, temperature = 0.7, maxTokens = 1000, stream = false } = options
  const normalizedTools = normalizeTools(tools)

  // Check cache for non-streaming requests
  if (!stream && !normalizedTools) {
    const cacheKey = getCacheKey(messages)
    const cached = getCachedResponse(cacheKey)
    if (cached) {
      console.log('[OpenAI] Cache hit')
      return cached
    }
  }

  try {
    const now = Date.now()
    const elapsed = now - lastRequestAt
    if (elapsed > 0 && elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) => window.setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed))
    }
    lastRequestAt = Date.now()

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: normalizedTools,
        tool_choice: normalizedTools ? 'auto' : undefined,
        temperature,
        max_tokens: maxTokens,
        stream,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI API error: ${response.status} ${error}`)
    }

    if (stream) {
      // Streaming not implemented in MVP
      throw new Error('Streaming not yet implemented')
    }

    const data = await response.json()
    const choice = data.choices[0]
    const message = choice.message

    const result: ChatCompletionResponse = {
      content: message.content || '',
      toolCalls: message.tool_calls,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    }

    // Cache successful responses
    if (!normalizedTools) {
      const cacheKey = getCacheKey(messages)
      setCachedResponse(cacheKey, result)
    }

    return result
  } catch (error) {
    console.error('[OpenAI] API request failed:', error)
    throw error
  }
}

/**
 * Check if OpenAI is configured and available
 */
export function isConfigured(): boolean {
  return !!API_KEY
}

/**
 * Clear the response cache
 */
export function clearCache(): void {
  responseCache.clear()
}

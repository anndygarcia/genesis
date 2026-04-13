// AI context management for Create Studio

import type { ChatMessage } from './openai'
import type { StudioObject } from './ai-tools'

export interface AIContext {
  conversationHistory: ChatMessage[]
  currentDesign: StudioObject[]
  lastAction: string | null
  lastActionTime: number | null
}

const STORAGE_KEY = 'create_studio_ai_context_v1'

/**
 * Default context
 */
const defaultContext: AIContext = {
  conversationHistory: [
    {
      role: 'system',
      content: 'You are an expert home design assistant. Help users design custom homes by understanding their requests and using the available tools to add, modify, and arrange objects in 3D space.'
    }
  ],
  currentDesign: [],
  lastAction: null,
  lastActionTime: null,
}

/**
 * Load context from localStorage
 */
export function loadAIContext(): AIContext {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaultContext }
    
    const parsed = JSON.parse(raw)
    return {
      conversationHistory: parsed.conversationHistory || defaultContext.conversationHistory,
      currentDesign: parsed.currentDesign || [],
      lastAction: parsed.lastAction || null,
      lastActionTime: parsed.lastActionTime || null,
    }
  } catch (error) {
    console.error('[AI Context] Failed to load:', error)
    return { ...defaultContext }
  }
}

/**
 * Save context to localStorage
 */
export function saveAIContext(context: AIContext): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(context))
  } catch (error) {
    console.error('[AI Context] Failed to save:', error)
  }
}

/**
 * Clear context (reset to default)
 */
export function clearAIContext(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * Add message to conversation history
 */
export function addMessage(context: AIContext, message: ChatMessage): AIContext {
  const updated = {
    ...context,
    conversationHistory: [...context.conversationHistory, message],
  }
  saveAIContext(updated)
  return updated
}

/**
 * Update current design state
 */
export function updateDesign(context: AIContext, objects: StudioObject[]): AIContext {
  const updated = {
    ...context,
    currentDesign: objects,
  }
  saveAIContext(updated)
  return updated
}

/**
 * Set last action
 */
export function setLastAction(context: AIContext, action: string): AIContext {
  const updated = {
    ...context,
    lastAction: action,
    lastActionTime: Date.now(),
  }
  saveAIContext(updated)
  return updated
}

/**
 * Trim conversation history to keep only recent messages
 * Keeps system prompt and last N messages
 */
export function trimHistory(context: AIContext, keepLastN = 10): AIContext {
  const systemMessage = context.conversationHistory[0]
  const recentMessages = context.conversationHistory.slice(-keepLastN)
  
  const updated = {
    ...context,
    conversationHistory: [systemMessage, ...recentMessages],
  }
  saveAIContext(updated)
  return updated
}

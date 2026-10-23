/** Minimal structural view of the DeepSeek Harness Cordis context this plugin uses. */
export interface DshContext {
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): () => boolean
  effect(setup: () => (() => void) | void, label?: string): void
  provide(name: string, value: unknown): () => void
  get(name: string): any
  logger: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  commands: {
    register(definition: CommandDefinition): () => void
  }
}

export interface CommandInvocation {
  agent: {
    session: {
      id: string
      requestHeader?: () => { config: { provider: string; model: string } } | undefined
      events?: () => readonly { type: string; data?: any }[]
    }
  }
  rawInput: string
  signal: AbortSignal
}

export interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

export interface CommandDefinition {
  name: string
  description: string
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>
}

export interface AgentSession {
  id: string
  requestHeader?: () => { config: { provider: string; model: string } } | undefined
  events?: () => readonly { type: string; data?: any }[]
}

export interface AgentRequestPayload {
  agent: { session: AgentSession }
  turn: number
  step: number
  signal: AbortSignal
}

export interface RequestErrorPayload {
  agent: { session: AgentSession }
  turn: number
  step: number
  provider: string
  failure: {
    message: string
    code: string
    status?: number
    providerRetryAfterMs?: number
  }
  signal: AbortSignal
}

export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  [key: string]: unknown
}

export interface Route {
  provider: string
  model: string
}

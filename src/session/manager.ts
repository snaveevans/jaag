import { AgentSession } from "./session.ts";

export interface SessionManagerOptions {
  inactivityTimeoutMs?: number;
  maxIterations?: number;
  buildSystemPrompt?: (now: Date) => string;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private interactiveSessionId: string | null = null;
  private readonly inactivityTimeoutMs: number;
  private readonly maxIterations: number;
  private readonly buildSystemPrompt: (now: Date) => string;

  constructor(options: SessionManagerOptions) {
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 10 * 60 * 1000;
    this.maxIterations = options.maxIterations ?? 50;
    this.buildSystemPrompt = options.buildSystemPrompt ?? (() => "You are a local agent daemon.");
  }

  getOrCreateInteractiveSession(now = new Date()): AgentSession {
    this.cleanupExpiredSessions(now);

    const current = this.getInteractiveSession();
    if (current && !current.isTerminal()) {
      return current;
    }

    const session = new AgentSession({
      systemPrompt: this.buildSystemPrompt(now),
      triggerSource: "user",
      createdAt: now,
      inactivityTimeoutMs: this.inactivityTimeoutMs,
      maxIterations: this.maxIterations,
    });

    this.sessions.set(session.id, session);
    this.interactiveSessionId = session.id;
    return session;
  }

  getInteractiveSession(): AgentSession | null {
    if (!this.interactiveSessionId) {
      return null;
    }

    const session = this.sessions.get(this.interactiveSessionId) ?? null;
    if (!session) {
      this.interactiveSessionId = null;
    }

    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  completeSession(sessionId: string, at = new Date()): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.markCompleted(at);
    this.pruneSession(sessionId);
  }

  failSession(sessionId: string, at = new Date()): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.markFailed(at);
    this.pruneSession(sessionId);
  }

  cleanupExpiredSessions(now = new Date()): void {
    const session = this.getInteractiveSession();
    if (!session) {
      return;
    }

    if (session.isTerminal()) {
      this.pruneSession(session.id);
      return;
    }

    if (session.isExpired(now)) {
      session.markCompleted(now);
      this.pruneSession(session.id);
    }
  }

  private pruneSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.interactiveSessionId === sessionId) {
      this.interactiveSessionId = null;
    }
  }
}

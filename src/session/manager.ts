import { AgentSession } from "./session.ts";
import type { TriggeredScheduleContext } from "../scheduler/types.ts";

export interface BuildSystemPromptInput {
  now: Date;
  triggerSource: "user" | "schedule";
  triggeredSchedule?: TriggeredScheduleContext;
}

export interface SessionManagerOptions {
  inactivityTimeoutMs?: number;
  maxIterations?: number;
  buildSystemPrompt?: (input: BuildSystemPromptInput) => string | Promise<string>;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private interactiveSessionId: string | null = null;
  private pendingInteractiveSession: Promise<AgentSession> | null = null;
  private readonly inactivityTimeoutMs: number;
  private readonly maxIterations: number;
  private readonly buildSystemPrompt: (input: BuildSystemPromptInput) => string | Promise<string>;

  constructor(options: SessionManagerOptions) {
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 10 * 60 * 1000;
    this.maxIterations = options.maxIterations ?? 50;
    this.buildSystemPrompt = options.buildSystemPrompt ?? (() => "You are a local agent daemon.");
  }

  async getOrCreateInteractiveSession(now = new Date()): Promise<AgentSession> {
    this.cleanupExpiredSessions(now);

    const current = this.getInteractiveSession();
    if (current && !current.isTerminal()) {
      return current;
    }

    if (this.pendingInteractiveSession) {
      return await this.pendingInteractiveSession;
    }

    const pendingSession = this.createSession({
      now,
      triggerSource: "user",
    });
    this.pendingInteractiveSession = pendingSession;

    try {
      const session = await pendingSession;
      this.sessions.set(session.id, session);
      this.interactiveSessionId = session.id;
      return session;
    } finally {
      if (this.pendingInteractiveSession === pendingSession) {
        this.pendingInteractiveSession = null;
      }
    }
  }

  async createTriggeredSession(triggeredSchedule: TriggeredScheduleContext, now = new Date()): Promise<AgentSession> {
    const session = await this.createSession({
      now,
      triggerSource: "schedule",
      triggeredSchedule,
    });

    this.sessions.set(session.id, session);
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

  private async createSession(input: BuildSystemPromptInput): Promise<AgentSession> {
    return new AgentSession({
      systemPrompt: await this.buildSystemPrompt({
        now: input.now,
        triggerSource: input.triggerSource,
        triggeredSchedule: input.triggeredSchedule,
      }),
      triggerSource: input.triggerSource,
      createdAt: input.now,
      inactivityTimeoutMs: this.inactivityTimeoutMs,
      maxIterations: this.maxIterations,
    });
  }

  private pruneSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.interactiveSessionId === sessionId) {
      this.interactiveSessionId = null;
    }
  }
}

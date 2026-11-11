// What the CRM does with calls: start an outbound one from the «Подзвонити» button,
// follow it through the ARI events, pop the card on an inbound one, and leave a
// 'call' note on the lead with the outcome and the duration.
//
// Outbound: ARI originates to the operator's phone (PJSIP/<agent>); when it answers,
// the channel continues in the dialplan's [outbound] context, which records the call
// and dials the lawyer through the trunk. The channel id is ours (crm-<n>), so the
// recording file name (…-out-<number>-<channel id>.wav on the PBX) and every event
// can be matched to the note.
//
// Inbound: the dialplan sends the call through Stasis(crm,inbound,<caller>) before
// ringing the operator. We let it continue at once, then look the caller up and tell
// the browsers who is calling.
import { randomUUID } from 'crypto';
import type { Queryable } from '../db';
import type { AriClient, AriEvent } from './ari';
import type { EventHub } from './hub';
import { countryCodeFor, formatE164, nationalPart, toDialable } from './phone';
import { tenant } from '../tenant';
import { ValidationError } from '../leads/repo';

export type CallOutcome = 'answered' | 'busy' | 'no_answer' | 'agent_no_answer' | 'cancelled' | 'failed' | 'missed';

export interface PbxSettings {
  /** CRM user e-mail → PJSIP endpoint name; default is the local part of the e-mail. */
  agents: Record<string, string>;
  /** CRM user whose name goes on inbound-call notes. */
  noteUserEmail: string;
  outboundContext: string;
  countryCode: string;
}

interface TrackedCall {
  direction: 'outbound' | 'inbound';
  channelId: string;
  number: string;
  sourceId: string | null;
  noteId: number | null;
  userId: number | null;
  startedAt: number;
  /** Outbound: the operator picked up. Inbound: the operator answered. */
  agentAnsweredAt: number | null;
  /** Outbound: the lawyer picked up. */
  answeredAt: number | null;
  dialStatus: string | null;
}

export interface CallerMatch {
  sourceId: string;
  fullName: string;
  city: string | null;
}

export function describeDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return tenant().strings.pbx.duration(m, s % 60);
}

/** Outcome from what the events told us about the call. */
export function outcomeOf(c: TrackedCall): CallOutcome {
  if (c.answeredAt) return 'answered';
  if (c.direction === 'inbound') return c.agentAnsweredAt ? 'answered' : 'missed';
  switch (c.dialStatus) {
    case 'BUSY': return 'busy';
    case 'NOANSWER': return 'no_answer';
    case 'CANCEL': return 'cancelled';
    case 'CONGESTION':
    case 'CHANUNAVAIL':
    case 'INVALIDARGS': return 'failed';
  }
  return c.agentAnsweredAt ? 'cancelled' : 'agent_no_answer';
}

export class PbxService {
  private readonly calls = new Map<string, TrackedCall>();
  private noteUserId: number | null | undefined;

  constructor(
    private readonly pool: Queryable,
    private readonly ari: AriClient,
    private readonly hub: EventHub,
    private readonly settings: PbxSettings,
    private readonly log: (line: string) => void = (line) => process.stdout.write(`[attorney_crm/pbx] ${line}\n`),
  ) {}

  get countryCode(): string {
    return this.settings.countryCode;
  }

  /** PJSIP endpoint that rings for this CRM user. */
  agentFor(userEmail: string): string {
    const email = userEmail.trim().toLowerCase();
    return this.settings.agents[email] ?? email.split('@')[0];
  }

  /** Rings the user's phone, then the lawyer. Writes the 'call' note straight away. */
  async startOutbound(sourceId: string, rawNumber: string, user: { id: number; email: string }, calleeName: string): Promise<{ channelId: string; number: string }> {
    const s = tenant().strings.pbx;
    const number = toDialable(rawNumber, this.settings.countryCode);
    if (!number) throw new ValidationError(s.badNumber(rawNumber));
    const channelId = `crm-${randomUUID()}`;
    const pretty = formatE164(number, this.settings.countryCode);
    const note = await this.pool.query<{ id: number }>(
      "INSERT INTO attorney_crm_notes (advocate_source_id, user_id, kind, body) VALUES ($1, $2, 'call', $3) RETURNING id",
      [sourceId, user.id, s.outboundNote(pretty, s.outcomes.started, channelId)],
    );
    const noteId = Number(note.rows[0].id);
    const call: TrackedCall = { direction: 'outbound', channelId, number, sourceId, noteId, userId: user.id, startedAt: Date.now(), agentAnsweredAt: null, answeredAt: null, dialStatus: null };
    this.calls.set(channelId, call);
    try {
      await this.ari.originate({
        endpoint: `PJSIP/${this.agentFor(user.email)}`,
        context: this.settings.outboundContext,
        extension: number,
        callerId: `"${calleeName.replace(/"/g, '')}" <${number}>`,
        channelId,
        variables: { CRM_SOURCE_ID: sourceId, CRM_USER: user.email },
      });
    } catch (err) {
      this.calls.delete(channelId);
      await this.updateNote(noteId, s.outboundNote(pretty, s.outcomes.failed, channelId));
      throw err;
    }
    this.hub.publish({ type: 'call', channelId, sourceId, number: pretty, status: 'ringing_agent', user: user.email });
    return { channelId, number };
  }

  /** Every event from the socket; unknown channels are ignored. */
  async handleEvent(e: AriEvent): Promise<void> {
    try {
      if (e.type === 'StasisStart' && e.channel && e.args?.[0] === 'inbound') return await this.onInbound(e);
      const id = e.channel?.id ?? e.caller?.id;
      const call = id ? this.calls.get(id) : undefined;
      if (!call) return;
      const at = e.timestamp ? Date.parse(e.timestamp) || Date.now() : Date.now();
      if (e.type === 'ChannelStateChange' && e.channel?.state === 'Up' && !call.agentAnsweredAt) {
        call.agentAnsweredAt = at;
        this.publish(call, call.direction === 'outbound' ? 'dialing' : 'answered');
      } else if (e.type === 'Dial' && call.direction === 'outbound' && e.caller?.id === call.channelId && e.dialstatus) {
        call.dialStatus = e.dialstatus;
        if (e.dialstatus === 'ANSWER') {
          call.answeredAt = at;
          this.publish(call, 'answered');
        }
      } else if (e.type === 'ChannelDestroyed') {
        this.calls.delete(call.channelId);
        await this.finish(call, at);
      }
    } catch (err) {
      this.log(`event ${e.type}: ${(err as Error).message}`);
    }
  }

  private publish(call: TrackedCall, status: string, extra: Record<string, unknown> = {}): void {
    this.hub.publish({ type: 'call', channelId: call.channelId, direction: call.direction, sourceId: call.sourceId, number: formatE164(call.number, this.settings.countryCode), status, ...extra });
  }

  private async finish(call: TrackedCall, endedAt: number): Promise<void> {
    const s = tenant().strings.pbx;
    const outcome = outcomeOf(call);
    const from = call.answeredAt ?? (call.direction === 'inbound' ? call.agentAnsweredAt : null);
    const duration = from ? describeDuration(endedAt - from) : null;
    const text = s.outcomes[outcome] + (duration ? `, ${duration}` : '');
    const pretty = formatE164(call.number, this.settings.countryCode);
    if (call.noteId) {
      await this.updateNote(call.noteId, call.direction === 'outbound' ? s.outboundNote(pretty, text, call.channelId) : s.inboundNote(pretty, text, call.channelId));
    }
    if (outcome === 'answered' && call.sourceId && call.userId) await this.markContacted(call.sourceId, call.userId);
    this.publish(call, 'ended', { outcome, duration });
  }

  private async onInbound(e: AriEvent): Promise<void> {
    const channel = e.channel!;
    const raw = e.args?.[1] || channel.caller?.number || '';
    // let the dialplan ring the operator first; the lookup can take a moment
    await this.ari.continueInDialplan(channel.id);
    const s = tenant().strings.pbx;
    const number = toDialable(raw, this.settings.countryCode);
    const pretty = number ? formatE164(number, this.settings.countryCode) : raw || s.unknownCaller;
    const match = number ? await this.findByPhone(number) : null;
    const call: TrackedCall = { direction: 'inbound', channelId: channel.id, number: number ?? raw, sourceId: match?.sourceId ?? null, noteId: null, userId: null, startedAt: Date.now(), agentAnsweredAt: null, answeredAt: null, dialStatus: null };
    if (match) {
      const userId = await this.inboundNoteUser();
      if (userId) {
        const note = await this.pool.query<{ id: number }>(
          "INSERT INTO attorney_crm_notes (advocate_source_id, user_id, kind, body) VALUES ($1, $2, 'call', $3) RETURNING id",
          [match.sourceId, userId, s.inboundNote(pretty, s.outcomes.ringing, channel.id)],
        );
        call.noteId = Number(note.rows[0].id);
        call.userId = userId;
      }
    }
    this.calls.set(channel.id, call);
    this.hub.publish({ type: 'inbound', channelId: channel.id, number: pretty, advocate: match });
    this.log(`inbound ${pretty} → ${match ? `${match.fullName} (${match.sourceId})` : 'no match'}`);
  }

  /** The lawyer whose registry phone or manual override ends with the caller's national number. */
  async findByPhone(dialable: string): Promise<CallerMatch | null> {
    const reg = tenant().registry;
    const pattern = `%${nationalPart(dialable, this.settings.countryCode)}`;
    const r = await this.pool.query<{ source_id: string; family_name: string; first_name: string; patronymic: string; city: string | null }>(
      `SELECT x.source_id, x.family_name, x.first_name, x.patronymic, x.city
         FROM (SELECT ${reg.select} FROM ${reg.table}) x
         LEFT JOIN attorney_crm_leads l ON l.advocate_source_id = x.source_id
        WHERE regexp_replace(COALESCE(l.phone_override, ''), '\\D', '', 'g') LIKE $1
           OR regexp_replace(COALESCE(x.phone, ''), '\\D', '', 'g') LIKE $1
        ORDER BY (l.phone_override IS NOT NULL) DESC, x.family_name
        LIMIT 1`,
      [pattern],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { sourceId: String(row.source_id), fullName: [row.family_name, row.first_name, row.patronymic].filter(Boolean).join(' '), city: row.city ?? null };
  }

  private async inboundNoteUser(): Promise<number | null> {
    if (this.noteUserId === undefined) {
      const r = await this.pool.query<{ id: number }>('SELECT id FROM attorney_crm_users WHERE email = $1', [this.settings.noteUserEmail.trim().toLowerCase()]);
      this.noteUserId = r.rows[0] ? Number(r.rows[0].id) : null;
      if (this.noteUserId === null) this.log(`no CRM user ${this.settings.noteUserEmail}: inbound calls will not be noted`);
    }
    return this.noteUserId;
  }

  private async updateNote(noteId: number, body: string): Promise<void> {
    await this.pool.query('UPDATE attorney_crm_notes SET body = $2 WHERE id = $1', [noteId, body]);
  }

  /** A lead that was still 'new' becomes 'contacted' after a conversation (same rule as campaign mail). */
  private async markContacted(sourceId: string, userId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO attorney_crm_leads (advocate_source_id, stage, updated_by) VALUES ($1, 'contacted', $2)
       ON CONFLICT (advocate_source_id) DO UPDATE SET stage = 'contacted', updated_at = NOW(), updated_by = $2
       WHERE attorney_crm_leads.stage = 'new'`,
      [sourceId, userId],
    );
  }

  /** For tests and the status endpoint. */
  get active(): number {
    return this.calls.size;
  }
}

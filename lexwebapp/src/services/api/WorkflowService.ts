/**
 * WorkflowService — API client for workflow sets and workflow execution.
 */

import { BaseService } from '../base/BaseService';
import type { WorkflowSet, Workflow } from '../../types/models/Workflow';
import { API_BASE } from '../../utils/api/base';

export interface WorkflowSSECallbacks {
  onStepStart?: (data: { workflowId: string; stepId: number; stepIndex: number; totalSteps: number; tool: string; purpose: string }) => void;
  onStepComplete?: (data: { workflowId: string; stepId: number; stepIndex: number; tool: string; result: unknown }) => void;
  onStepError?: (data: { workflowId: string; stepId?: number; tool?: string; error: string }) => void;
  onWorkflowComplete?: (data: { workflowId: string; status: string; stepCount: number; costUsd: number }) => void;
  onAnalysisStart?: (data: { workflowId: string }) => void;
  onAnalysisDelta?: (data: { workflowId: string; text: string }) => void;
  onAnalysisComplete?: (data: { workflowId: string; analysis: string }) => void;
  onError?: (error: string) => void;
}

export class WorkflowService extends BaseService {
  async listWorkflowSets(): Promise<WorkflowSet[]> {
    return this.request(
      () => this.client.get('/api/workflow-sets'),
      (data: { workflow_sets?: WorkflowSet[] }) => data.workflow_sets || []
    );
  }

  async getWorkflowSet(id: string): Promise<WorkflowSet> {
    return this.request(() => this.client.get(`/api/workflow-sets/${id}`));
  }

  async getWorkflow(id: string): Promise<Workflow> {
    return this.request(() => this.client.get(`/api/workflows/${id}`));
  }

  async deleteWorkflowSet(id: string): Promise<void> {
    return this.requestVoid(() => this.client.delete(`/api/workflow-sets/${id}`));
  }

  async listPresets(): Promise<Array<{ id: string; title: string; description: string; icon: string; category: string; tags: string[]; stepsCount: number }>> {
    return this.request(
      () => this.client.get('/api/workflow-sets/presets'),
      (data: { presets?: Array<{ id: string; title: string; description: string; icon: string; category: string; tags: string[]; stepsCount: number }> }) => data.presets || []
    );
  }

  async createFromPreset(presetId: string): Promise<WorkflowSet> {
    return this.request(() => this.client.post(`/api/workflow-sets/presets/${presetId}`));
  }

  async cancelWorkflow(id: string): Promise<void> {
    return this.requestVoid(() => this.client.post(`/api/workflows/${id}/cancel`));
  }

  executeWorkflow(id: string, callbacks: WorkflowSSECallbacks): () => void {
    const token = localStorage.getItem('auth_token');
    const baseUrl = API_BASE;

    const abortController = new AbortController();

    fetch(`${baseUrl}/api/workflows/${id}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          callbacks.onError?.(error.error || `HTTP ${response.status}`);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ') && eventType) {
              try {
                const data = JSON.parse(line.slice(6));
                this.handleSSEEvent(eventType, data, callbacks);
              } catch {
                // skip malformed
              }
              eventType = '';
            }
          }
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          callbacks.onError?.(err.message);
        }
      });

    return () => abortController.abort();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE events are parsed JSON with dynamic shapes per event type
  private handleSSEEvent(type: string, data: Record<string, any>, callbacks: WorkflowSSECallbacks): void {
    switch (type) {
      case 'step_start':
        callbacks.onStepStart?.(data as Parameters<NonNullable<WorkflowSSECallbacks['onStepStart']>>[0]);
        break;
      case 'step_complete':
        callbacks.onStepComplete?.(data as Parameters<NonNullable<WorkflowSSECallbacks['onStepComplete']>>[0]);
        break;
      case 'step_error':
        callbacks.onStepError?.(data as Parameters<NonNullable<WorkflowSSECallbacks['onStepError']>>[0]);
        break;
      case 'workflow_complete':
        callbacks.onWorkflowComplete?.(data as Parameters<NonNullable<WorkflowSSECallbacks['onWorkflowComplete']>>[0]);
        break;
      case 'analysis_start':
        callbacks.onAnalysisStart?.(data as Parameters<NonNullable<WorkflowSSECallbacks['onAnalysisStart']>>[0]);
        break;
      case 'analysis_delta':
        callbacks.onAnalysisDelta?.(data as Parameters<NonNullable<WorkflowSSECallbacks['onAnalysisDelta']>>[0]);
        break;
      case 'analysis_complete':
        callbacks.onAnalysisComplete?.(data as Parameters<NonNullable<WorkflowSSECallbacks['onAnalysisComplete']>>[0]);
        break;
      case 'error':
        callbacks.onError?.(String(data.error || 'Unknown error'));
        break;
    }
  }
}

export const workflowService = new WorkflowService();

import {
  type CreatePipelineStageBody,
  type CreateTaskBody,
  LeadPage,
  type MoveLeadInput,
  PipelineBoardDto,
  PipelineLeadDto,
  PipelineLeadPage,
  PipelineStageDto,
  PipelineStageList,
  TaskDeletedDto,
  TaskDto,
  TaskPage,
  type UpdatePipelineStageBody,
  type UpdateTaskBody,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * CRM pipeline calls of the dashboard (S10-03), as the signed-in member: the board, a column's next page, the lead
 * list of one stage, a drag, and the stage settings (admins; the API refuses everyone else).
 */

/** `me`, `unassigned` or nothing (everyone's leads). */
export type AssignedFilter = 'me' | 'unassigned' | undefined;

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

export function fetchPipelineBoard(
  session: SessionRef,
  assigned: AssignedFilter,
  limit = 20,
): Promise<ApiResult<PipelineBoardDto>> {
  return apiRequest(session, `/v1/crm/pipeline/board?${query({ limit, assigned })}`, PipelineBoardDto);
}

export function fetchStageLeads(
  session: SessionRef,
  stageId: string,
  cursor: string,
  assigned: AssignedFilter,
): Promise<ApiResult<PipelineLeadPage>> {
  return apiRequest(
    session,
    `/v1/crm/pipeline/stages/${encodeURIComponent(stageId)}/leads?${query({ limit: 20, cursor, assigned })}`,
    PipelineLeadPage,
  );
}

export function fetchPipelineStages(
  session: SessionRef,
  includeArchived = false,
): Promise<ApiResult<PipelineStageList>> {
  return apiRequest(
    session,
    `/v1/crm/pipeline/stages?${query({ includeArchived: includeArchived ? 'true' : undefined })}`,
    PipelineStageList,
  );
}

/** The list view: the inbox (newest first), optionally one stage. */
export function fetchLeadList(
  session: SessionRef,
  opts: { stageId?: string | undefined; cursor?: string | undefined; assigned: AssignedFilter },
): Promise<ApiResult<LeadPage>> {
  return apiRequest(
    session,
    `/v1/crm/leads?${query({ limit: 50, stageId: opts.stageId, cursor: opts.cursor, assigned: opts.assigned })}`,
    LeadPage,
  );
}

export function moveLead(
  session: SessionRef,
  leadId: string,
  body: MoveLeadInput,
): Promise<ApiResult<PipelineLeadDto>> {
  return apiRequest(session, `/v1/crm/leads/${encodeURIComponent(leadId)}/move`, PipelineLeadDto, {
    method: 'POST',
    body,
  });
}

export function createPipelineStage(
  session: SessionRef,
  body: CreatePipelineStageBody,
  idempotencyKey: string,
): Promise<ApiResult<PipelineStageDto>> {
  return apiRequest(session, '/v1/crm/pipeline/stages', PipelineStageDto, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function updatePipelineStage(
  session: SessionRef,
  id: string,
  body: UpdatePipelineStageBody,
): Promise<ApiResult<PipelineStageDto>> {
  return apiRequest(session, `/v1/crm/pipeline/stages/${encodeURIComponent(id)}`, PipelineStageDto, {
    method: 'PATCH',
    body,
  });
}

export function reorderPipelineStages(session: SessionRef, stageIds: string[]): Promise<ApiResult<PipelineStageList>> {
  return apiRequest(session, '/v1/crm/pipeline/stages/order', PipelineStageList, {
    method: 'PUT',
    body: { stageIds },
  });
}

// ---- tasks (S10-05) ---------------------------------------------------------------------------------------------------

export interface TaskListOptions {
  assignee: 'me' | 'any';
  status: 'OPEN' | 'DONE';
  dueFrom?: Date | undefined;
  dueTo?: Date | undefined;
  noDue?: boolean | undefined;
  cursor?: string | undefined;
}

export function fetchTasks(session: SessionRef, o: TaskListOptions): Promise<ApiResult<TaskPage>> {
  return apiRequest(
    session,
    `/v1/crm/tasks?${query({
      limit: 50,
      assignee: o.assignee,
      status: o.status,
      dueFrom: o.dueFrom?.toISOString(),
      dueTo: o.dueTo?.toISOString(),
      noDue: o.noDue ? 'true' : undefined,
      cursor: o.cursor,
    })}`,
    TaskPage,
  );
}

export function createTask(
  session: SessionRef,
  body: CreateTaskBody,
  idempotencyKey: string,
): Promise<ApiResult<TaskDto>> {
  return apiRequest(session, '/v1/crm/tasks', TaskDto, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function updateTask(session: SessionRef, id: string, body: UpdateTaskBody): Promise<ApiResult<TaskDto>> {
  return apiRequest(session, `/v1/crm/tasks/${encodeURIComponent(id)}`, TaskDto, { method: 'PATCH', body });
}

export function deleteTask(session: SessionRef, id: string): Promise<ApiResult<TaskDeletedDto>> {
  return apiRequest(session, `/v1/crm/tasks/${encodeURIComponent(id)}`, TaskDeletedDto, { method: 'DELETE' });
}

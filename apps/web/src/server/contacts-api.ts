import {
  ContactDto,
  type ContactLookupBody,
  ContactLookupDto,
  ContactNoteDto,
  ContactNotePage,
  ContactPage,
  type ContactType,
  type CreateContactNoteBody,
  type CreateDataExportBody,
  DataExportDto,
  DataExportPage,
  LeadDto,
  LeadPage,
  type LeadSource,
  type LeadStatus,
  type MergeContactsBody,
} from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/**
 * Contacts, lead inbox and data export calls of the dashboard (S11-F14), as the signed-in member. The API decides who
 * may do what (admins export and merge; members read); these are transport only.
 */

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
};

export function fetchContacts(
  session: SessionRef,
  o: {
    type?: ContactType | undefined;
    owner?: 'me' | undefined;
    tag?: string | undefined;
    cursor?: string | undefined;
  },
): Promise<ApiResult<ContactPage>> {
  return apiRequest(
    session,
    `/v1/crm/contacts?${query({ limit: 25, type: o.type, owner: o.owner, tag: o.tag, cursor: o.cursor })}`,
    ContactPage,
  );
}

export function fetchContact(session: SessionRef, id: string): Promise<ApiResult<ContactDto>> {
  return apiRequest(session, `/v1/crm/contacts/${encodeURIComponent(id)}`, ContactDto);
}

/** The duplicate check / "find by e-mail or phone": exact, normalized, in a body so PII never sits in a URL. */
export function lookupContacts(session: SessionRef, body: ContactLookupBody): Promise<ApiResult<ContactLookupDto>> {
  return apiRequest(session, '/v1/crm/contacts/lookup', ContactLookupDto, { method: 'POST', body });
}

export function mergeContacts(
  session: SessionRef,
  id: string,
  body: MergeContactsBody,
): Promise<ApiResult<ContactDto>> {
  return apiRequest(session, `/v1/crm/contacts/${encodeURIComponent(id)}/merge`, ContactDto, { method: 'POST', body });
}

export function fetchContactNotes(
  session: SessionRef,
  id: string,
  cursor?: string,
): Promise<ApiResult<ContactNotePage>> {
  return apiRequest(
    session,
    `/v1/crm/contacts/${encodeURIComponent(id)}/notes?${query({ limit: 20, cursor })}`,
    ContactNotePage,
  );
}

export function addContactNote(
  session: SessionRef,
  id: string,
  body: CreateContactNoteBody,
): Promise<ApiResult<ContactNoteDto>> {
  return apiRequest(session, `/v1/crm/contacts/${encodeURIComponent(id)}/notes`, ContactNoteDto, {
    method: 'POST',
    body,
  });
}

export function fetchLeads(
  session: SessionRef,
  o: {
    status?: LeadStatus | undefined;
    source?: LeadSource | undefined;
    assigned?: 'me' | 'unassigned' | undefined;
    cursor?: string | undefined;
  },
): Promise<ApiResult<LeadPage>> {
  return apiRequest(
    session,
    `/v1/crm/leads?${query({ limit: 25, status: o.status, source: o.source, assigned: o.assigned, cursor: o.cursor })}`,
    LeadPage,
  );
}

export function fetchLead(session: SessionRef, id: string): Promise<ApiResult<LeadDto>> {
  return apiRequest(session, `/v1/crm/leads/${encodeURIComponent(id)}`, LeadDto);
}

export function fetchDataExports(session: SessionRef): Promise<ApiResult<DataExportPage>> {
  return apiRequest(session, `/v1/agency/data-exports?${query({ limit: 10 })}`, DataExportPage);
}

/** A fresh second-factor code travels in the body: the API checks it, whatever this page did before. */
export function createDataExport(
  session: SessionRef,
  body: CreateDataExportBody,
  idempotencyKey: string,
): Promise<ApiResult<DataExportDto>> {
  return apiRequest(session, '/v1/agency/data-exports', DataExportDto, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
}

/** One export; `download` asks for a short-lived signed link while the file is available (audited). */
export function fetchDataExport(session: SessionRef, id: string, download: boolean): Promise<ApiResult<DataExportDto>> {
  return apiRequest(
    session,
    `/v1/agency/data-exports/${encodeURIComponent(id)}?${query({ download: download ? '1' : undefined })}`,
    DataExportDto,
  );
}

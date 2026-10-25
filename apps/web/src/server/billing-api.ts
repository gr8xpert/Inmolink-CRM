import { BillingOverviewDto, BillingRedirectDto, InvoicePage, type StartCheckoutBody } from '@inmolink/contracts';
import { type ApiResult, apiRequest, type SessionRef } from './api';

/** Billing calls of the dashboard (S13-01), as the signed-in member: transport only, the API decides. */

export function fetchBillingOverview(session: SessionRef): Promise<ApiResult<BillingOverviewDto>> {
  return apiRequest(session, '/v1/billing', BillingOverviewDto);
}

export function fetchInvoices(session: SessionRef, cursor?: string): Promise<ApiResult<InvoicePage>> {
  const q = new URLSearchParams({ limit: '25' });
  if (cursor) q.set('cursor', cursor);
  return apiRequest(session, `/v1/billing/invoices?${q}`, InvoicePage);
}

export function startCheckout(session: SessionRef, body: StartCheckoutBody): Promise<ApiResult<BillingRedirectDto>> {
  // Stripe is called during this request: give it Stripe's time.
  return apiRequest(session, '/v1/billing/checkout', BillingRedirectDto, { method: 'POST', body, timeoutMs: 30_000 });
}

export function openPortal(session: SessionRef): Promise<ApiResult<BillingRedirectDto>> {
  return apiRequest(session, '/v1/billing/portal', BillingRedirectDto, { method: 'POST', timeoutMs: 30_000 });
}

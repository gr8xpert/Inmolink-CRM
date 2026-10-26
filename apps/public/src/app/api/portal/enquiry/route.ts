import { enquiryResponse } from '@/portal/enquiry';

/** The portal's enquiry form post (S15-02): a plain form POST (or the form's script), answered by `enquiryResponse`. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return enquiryResponse(request);
}

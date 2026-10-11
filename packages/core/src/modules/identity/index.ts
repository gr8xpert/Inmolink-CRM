/** identity — login identity, sign-up with agency-of-one, memberships, team and invites, staff (S0-09, S1-01, S1-02, S1-03). */
export { configureIdentity, type IdentityConfig, TOKEN_TTL_MS } from './config';
export { identityErrors } from './errors';
export { identityEvents } from './events';
export { identityJobs } from './jobs';
export {
  acceptInvite,
  changeMemberRole,
  deactivateMember,
  getMemberRole,
  inviteMember,
  isSessionValid,
  issueAccessToken,
  listInvites,
  listMembers,
  register,
  requestPasswordReset,
  resetPassword,
  revokeInvite,
  verifyCredentials,
  verifyEmail,
} from './service';
export {
  getStaffRole,
  grantStaff,
  listAgencyAdmins,
  revokeStaff,
  STAFF_ROLES,
  type StaffRole,
} from './staff';
export { registerIdentitySubscriptions, unregisterIdentitySubscriptions } from './subscriptions';

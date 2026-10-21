/**
 * website-api emits no events (S7-03): it reads, and its lead intake (S7-05) emits `websites.lead.received` through the
 * `websites` module that owns the leads. Declared so the worker's module map stays uniform.
 */
export const websiteApiEvents = {};

// Re-export NotificationQueryPort from core so notification adapters can import
// from this module without knowing the interface lives in core.
export type { NotificationQueryPort } from "../core/ports";

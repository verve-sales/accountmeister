import type { MailCalendarAdapter } from "./adapter";
import { GraphAdapter } from "./graph/adapter";

export function getMailCalendarAdapter(): MailCalendarAdapter {
  return new GraphAdapter();
}
export { AdapterError } from "./adapter";

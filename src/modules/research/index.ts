import type { CompanyResearchAdapter } from "./adapter";
import { FixtureResearchAdapter } from "./fixture/adapter";

export function getCompanyResearchAdapter(): CompanyResearchAdapter {
  return new FixtureResearchAdapter();
}
export { ResearchAdapterError } from "./adapter";

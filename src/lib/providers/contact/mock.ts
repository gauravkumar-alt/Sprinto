/** MockContactProvider — returns fictional people for `.example` fixture domains only. Never invents people for real domains. */
import { MOCK_SITES } from "@/lib/providers/mockFixtures";
import type { ContactProvider, ContactSearchResult } from "./types";

export class MockContactProvider implements ContactProvider {
  readonly name = "mock-contacts";
  readonly dataSource = "mock" as const;
  async domainSearch(domain: string): Promise<ContactSearchResult> {
    const site = MOCK_SITES[domain];
    return {
      candidates: (site?.contacts ?? []).map((c) => ({ ...c, provider: "mock" as const, dataSource: "mock" as const })),
      fromCache: false,
      organization: null,
      requestCounted: false,
    };
  }
}

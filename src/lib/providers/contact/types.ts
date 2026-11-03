import type { ContactCandidate, DataSource } from "@/lib/schemas";

export interface ContactSearchResult {
  candidates: ContactCandidate[];
  fromCache: boolean;
  organization: string | null;
  requestCounted: boolean;
}

export interface ContactProvider {
  readonly name: string;
  readonly dataSource: DataSource;
  domainSearch(domain: string): Promise<ContactSearchResult>;
}

export class ContactProviderError extends Error {
  constructor(message: string, readonly kind: "auth" | "rate_limit" | "quota" | "unavailable" | "bad_request") {
    super(message);
    this.name = "ContactProviderError";
  }
}

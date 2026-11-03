import type { DataSource } from "@/lib/schemas";

export interface OutgoingEmail {
  subject: string;
  body: string;
  /** Prospect addresses known for this company — used ONLY to prove they are absent from the message. */
  prospectEmails: (string | null)[];
}

export interface SendResult {
  status: "sent" | "simulated";
  messageId: string;
  threadId: string | null;
  recipient: string;
}

/** Note: there is deliberately no way to pass a recipient. Delivery always goes to DEMO_INBOX_EMAIL. */
export interface EmailProvider {
  readonly name: string;
  readonly dataSource: DataSource;
  readonly deliveryRecipient: string;
  verifyIdentity(): Promise<{ authenticatedEmail: string }>;
  send(email: OutgoingEmail): Promise<SendResult>;
}

export class EmailSendError extends Error {
  constructor(message: string, readonly kind: "auth" | "recipient" | "api" | "timeout" | "config") {
    super(message);
    this.name = "EmailSendError";
  }
}

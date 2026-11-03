/** MockEmailProvider — never sends anything. Results are SIMULATED, never SENT. The same safety checks run on the message. */
import crypto from "node:crypto";
import { getConfig } from "@/lib/config";
import { buildMime } from "./mime";
import { assertMessageSafe, RecipientViolation } from "./recipientGuard";
import { EmailSendError, type EmailProvider, type OutgoingEmail, type SendResult } from "./types";

export class MockEmailProvider implements EmailProvider {
  readonly name = "mock-email";
  readonly dataSource = "mock" as const;
  get deliveryRecipient() {
    return getConfig().demoInboxEmail || "you@your-inbox.invalid";
  }
  async verifyIdentity() {
    return { authenticatedEmail: this.deliveryRecipient };
  }
  async send(email: OutgoingEmail): Promise<SendResult> {
    const to = this.deliveryRecipient;
    const raw = buildMime({ fromName: getConfig().senderName, fromEmail: to, to, subject: email.subject, body: email.body });
    try {
      assertMessageSafe(raw, { demoInbox: to, prospectEmails: email.prospectEmails });
    } catch (e) {
      if (e instanceof RecipientViolation) throw new EmailSendError(e.message, "recipient");
      throw e;
    }
    return { status: "simulated", messageId: `simulated-${crypto.randomUUID()}`, threadId: null, recipient: to };
  }
}

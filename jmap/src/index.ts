export { jmap } from "./integration.js";
export type { Integration, IntegrationEvent, IntegrationHost, JmapItx } from "./integration.js";
export { fastmailCopies, mailbox } from "./mailbox.js";
export type {
  Address,
  AddressInput,
  Attachment,
  CreateMaskedEmail,
  EmailDetail,
  EmailSummary,
  Identity,
  JmapMailbox,
  Mailbox,
  MaskedEmail,
  MaskedEmailState,
  SearchInput,
  SendInput,
  SendResult,
} from "./mailbox.js";
export { fastmailVerdict } from "./forwarded.js";
export type { FastmailCopy, FastmailVerdict, ForwardedMail, Header } from "./forwarded.js";

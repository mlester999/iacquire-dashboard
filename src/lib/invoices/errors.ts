/** A problem with what a person typed into an invoice form. The message is plain and safe to show. */
export class InvoiceInputError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "InvoiceInputError";
  }
}

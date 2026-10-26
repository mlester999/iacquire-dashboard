// A multipart/form-data body, built by hand so a PDF can be uploaded as bytes (the fetch helpers elsewhere in the product send and read text only). Pure: the caller supplies the
// boundary, so the same parts and boundary always make the same bytes.

export interface MultipartPart {
  name: string;
  value: string | Buffer;
  /** Present for a file. */
  filename?: string;
  contentType?: string;
}

export class MultipartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultipartError";
  }
}

const BOUNDARY_RE = /^[A-Za-z0-9'()+_,./:=?-]{16,70}$/;
// A header value can carry no line break and no quote: either would let a part's name or file name write headers of its own.
const SAFE_HEADER_TEXT = /^[^\r\n"\\]{1,200}$/;

/** The body and its Content-Type. Refuses a name or file name that could break out of its header, and a boundary that also occurs inside a part. */
export function buildMultipart(parts: readonly MultipartPart[], boundary: string): { contentType: string; body: Buffer } {
  if (!BOUNDARY_RE.test(boundary)) throw new MultipartError("The multipart boundary is not valid.");
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (!SAFE_HEADER_TEXT.test(part.name)) throw new MultipartError("A multipart field name is not valid.");
    if (part.filename !== undefined && !SAFE_HEADER_TEXT.test(part.filename)) throw new MultipartError("A multipart file name is not valid.");
    if (part.contentType !== undefined && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(part.contentType)) throw new MultipartError("A multipart content type is not valid.");
    const value = typeof part.value === "string" ? Buffer.from(part.value, "utf8") : part.value;
    if (value.includes(delimiter)) throw new MultipartError("The multipart boundary occurs inside a part, so the body would be ambiguous.");
    const head = [`--${boundary}`, `Content-Disposition: form-data; name="${part.name}"${part.filename !== undefined ? `; filename="${part.filename}"` : ""}`];
    if (part.contentType) head.push(`Content-Type: ${part.contentType}`);
    chunks.push(Buffer.from(`${head.join("\r\n")}\r\n\r\n`, "utf8"), value, Buffer.from("\r\n", "latin1"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "latin1"));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

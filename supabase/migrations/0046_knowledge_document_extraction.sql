-- Knowledge document extraction: bounded PDF/DOCX processing states, extraction evidence and a safe retry path.
--
-- Renumbered from 0042 to follow 0045 and the hosted schema's existing 0041-0044 CRM migrations. The status check and
-- columns are idempotent; the migration may be re-run after an interrupted deploy.
--
-- The uploaded file is stored before extraction starts. A row is inserted as "processing", then moves to one of:
--   ready       selectable text was extracted and released (or the document is plain text);
--   failed      extraction crashed or the document was malformed;
--   unsupported encrypted, scanned/image-only, ZIP64 or an unsupported filter; OCR is not implemented;
--   ready + risk_flags + applied_at = null   held for iAcquire review by the existing prompt-injection guard.
-- Existing rows are unaffected. The status check is widened only; the old values remain valid.

alter table knowledge_documents drop constraint if exists knowledge_documents_status_check;
alter table knowledge_documents add constraint knowledge_documents_status_check
  check (status in ('uploaded', 'processing', 'ready', 'failed', 'unsupported', 'rejected', 'deleted'));
alter table knowledge_documents add column if not exists processing_detail text
  check (processing_detail is null or char_length(processing_detail) <= 500);
alter table knowledge_documents add column if not exists extraction_method text
  check (extraction_method is null or extraction_method in ('plain_text', 'pdf', 'docx'));
alter table knowledge_documents add column if not exists processed_at timestamptz;

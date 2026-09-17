# Scanned PDF OCR validation

The OCR fallback uses `gpt-5.4-mini` with low reasoning effort through the
configured LLMoxie gateway. This model is listed by `/v1/models` for LLteacher's
current token and successfully accepts the image requests. Both Luna identifiers
were rejected for that token; the selected model was changed at the user's request.

Poppler renders one page at a time, with a maximum dimension of 2400 pixels.
Transcription preserves page boundaries and identifies the model. PDF retries
run asynchronously through the existing two-job queue. No partial transcription
is published if a page fails. Limits: 64 pages, 30 seconds per render, 90 seconds
per model request, and 20 minutes per document; rate limits and server errors
receive two bounded retries.

## Real-file results

Verified through the isolated running API and local Postgres/MinIO test environment:

| File | Pages | OKF characters | Final status |
| --- | --- | --- | --- |
| `Ali(Econ 201)/Textbook Scans/Acem.pdf` | 31 | 118,302 | Ready |
| `Ali(Econ 201)/Textbook Scans/Ch12_HO.pdf` | 48 | 160,942 | Ready |

Both documents have every expected page heading in sequence and no extraction
error. Knowledge search returns Acem for `Acem` and Ch12_HO for `Glamping Airstream`.
The original uploaded PDFs remain stored.

A representative page transcription preserved its main prose and numerical
values on visual comparison, but misread a small photo credit. This is a spot
check, not a full accuracy audit of all 79 pages. Equations, tables, and unclear
text should still be checked against the original scans.

## Automated checks

- Initial OCR implementation: 85 focused tests passed.
- Full web suite before the model-only switch: 2,083 passed, six optional S3 tests skipped.
- After switching to GPT-5.4 mini: ten OCR/PDF tests and web typecheck passed.
- Web production build passed for the OCR implementation.
- `git diff --check` passed.

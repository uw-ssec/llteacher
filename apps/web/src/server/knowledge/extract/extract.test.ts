import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extract, sniffTranscript } from "./index";
import { decodeXml, MAX_PART_BYTES } from "./types";
import { MAX_TOTAL_PART_BYTES, makeSizeBudget } from "./pptx";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))).buffer as ArrayBuffer;

const SRT = "1\n00:00:01,000 --> 00:00:04,000\nWelcome to Econ 201.\n\n2\n00:00:05,000 --> 00:00:08,000\nToday: supply and demand.\n";

const MINIMAL_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 24 Tf 72 700 Td (Supply and demand set price) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>`;

const EMPTY_PDF = MINIMAL_PDF.replace("(Supply and demand set price) Tj", "");

describe("sniffTranscript", () => {
  it("detects SRT and VTT cue lines", () => {
    expect(sniffTranscript(SRT)).toBe(true);
    expect(sniffTranscript("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHi")).toBe(true);
    expect(sniffTranscript("Just a syllabus paragraph.")).toBe(false);
  });
});

describe("extract", () => {
  it("converts a .txt that is really SRT into a transcript concept", async () => {
    const out = await extract("Lecture 1 captions.txt", enc(SRT));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript", title: "Lecture 1 captions" });
    expect((out as { markdown: string }).markdown).toBe("Welcome to Econ 201.\n\nToday: supply and demand.");
  });
  it("passes markdown and plain text through as notes", async () => {
    const out = await extract("notes.md", enc("# Notes\n\nBody."));
    expect(out).toMatchObject({ kind: "extracted", type: "note", markdown: "# Notes\n\nBody." });
  });
  it("reads docx paragraphs and headings", async () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Module 1</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Supply and </w:t></w:r><w:r><w:t>demand.</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Elasticity</w:t></w:r></w:p>
      <w:p><w:r><w:t>Responds to price.</w:t></w:r></w:p></w:body></w:document>`;
    const out = await extract("Lecture 2.docx", zip({ "word/document.xml": xml }));
    expect(out).toMatchObject({ kind: "extracted", type: "lecture", title: "Module 1" });
    expect((out as { markdown: string }).markdown).toBe("# Module 1\n\nSupply and demand.\n\n## Elasticity\n\nResponds to price.");
  });
  it("falls back to the filename for docx with no heading styles at all", async () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:r><w:t>Plain intro paragraph.</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second plain paragraph.</w:t></w:r></w:p></w:body></w:document>`;
    const out = await extract("Notes plain.docx", zip({ "word/document.xml": xml }));
    expect(out).toMatchObject({ kind: "extracted", type: "lecture", title: "Notes plain" });
    expect((out as { markdown: string }).markdown).toBe("Plain intro paragraph.\n\nSecond plain paragraph.");
  });
  it("rejects a docx zip bomb: an oversized word/document.xml is never decompressed", async () => {
    const bytes = zip({ "word/document.xml": " ".repeat(51 * 1024 * 1024) });
    const out = await extract("Bomb.docx", bytes);
    expect(out).toMatchObject({ kind: "unsupported" });
    expect((out as { reason: string }).reason).toMatch(/50 MB/);
  });
  it("reads pptx slides in order with slide headings", async () => {
    const slide = (t: string) => `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const out = await extract("Deck.pptx", zip({ "ppt/slides/slide2.xml": slide("Second"), "ppt/slides/slide1.xml": slide("First"), "ppt/slides/slide10.xml": slide("Tenth") }));
    expect(out).toMatchObject({ kind: "extracted", type: "slides", title: "Deck" });
    expect((out as { markdown: string }).markdown).toBe("## Slide 1\n\nFirst\n\n## Slide 2\n\nSecond\n\n## Slide 10\n\nTenth");
  });
  it("orders pptx slides by the presentation's own sldId order, not the slideN.xml filenames", async () => {
    const slide = (t: string) => `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const presentationXml = `<?xml version="1.0"?><p:presentation xmlns:p="x" xmlns:r="y"><p:sldIdLst>
      <p:sldId id="256" r:id="rId2"/>
      <p:sldId id="257" r:id="rId3"/>
      <p:sldId id="258" r:id="rId1"/>
    </p:sldIdLst></p:presentation>`;
    const relsXml = `<?xml version="1.0"?><Relationships xmlns="z">
      <Relationship Id="rId1" Type="slide" Target="slides/slide1.xml"/>
      <Relationship Id="rId2" Type="slide" Target="slides/slide2.xml"/>
      <Relationship Id="rId3" Type="slide" Target="slides/slide3.xml"/>
    </Relationships>`;
    const out = await extract(
      "Deck.pptx",
      zip({
        "ppt/slides/slide1.xml": slide("Alpha"),
        "ppt/slides/slide2.xml": slide("Beta"),
        "ppt/slides/slide3.xml": slide("Gamma"),
        "ppt/presentation.xml": presentationXml,
        "ppt/_rels/presentation.xml.rels": relsXml,
      }),
    );
    expect(out).toMatchObject({ kind: "extracted", type: "slides", title: "Deck" });
    expect((out as { markdown: string }).markdown).toBe(
      "## Slide 1\n\nBeta\n\n## Slide 2\n\nGamma\n\n## Slide 3\n\nAlpha",
    );
  });
  it("reads a text-layer PDF", async () => {
    const out = await extract("Reading.pdf", enc(MINIMAL_PDF));
    expect(out).toMatchObject({ kind: "extracted", type: "reading", title: "Reading" });
    expect((out as { markdown: string }).markdown).toContain("Supply and demand set price");
  });
  it("marks a PDF with no text layer as unsupported", async () => {
    const out = await extract("Scan.pdf", enc(EMPTY_PDF));
    expect(out).toMatchObject({ kind: "unsupported" });
    expect((out as { reason: string }).reason).toMatch(/no text layer/i);
  });
  it("never throws on garbage bytes", async () => {
    expect((await extract("x.docx", enc("not a zip"))).kind).toBe("unsupported");
    expect((await extract("x.pptx", enc("not a zip"))).kind).toBe("unsupported");
    expect((await extract("x.pdf", enc("not a pdf"))).kind).toBe("unsupported");
  });
  it("reports unknown formats as unsupported", async () => {
    expect(await extract("audio.mp3", enc(""))).toMatchObject({ kind: "unsupported" });
  });
});

describe("decodeXml", () => {
  it("decodes hex numeric entities before decimal and named entities", () => {
    expect(decodeXml("&#x2019;&#39;&amp;lt;")).toBe("’'&lt;");
  });
});

/* Final review: MAX_PART_BYTES caps ONE zip entry, which bounds nothing for
   a format that is many entries -- 5,000 slides of 49 MB each clear the
   per-entry guard individually and decompress to a quarter of a terabyte.
   The aggregate cap is tested through its helper rather than through a real
   200 MB pptx, because building one costs 200 MB of test memory to prove
   arithmetic that is right here in front of us. */
describe("pptx aggregate size budget", () => {
  it("caps the total at four times the per-entry limit", () => {
    expect(MAX_TOTAL_PART_BYTES).toBe(4 * MAX_PART_BYTES);
    expect(MAX_TOTAL_PART_BYTES).toBe(200 * 1024 * 1024);
  });

  it("admits entries until the budget is spent, then refuses the rest", () => {
    const budget = makeSizeBudget(100);
    expect(budget.admit(60)).toBe(true);
    expect(budget.admit(40)).toBe(true); // exactly at the limit still fits
    expect(budget.exceeded).toBe(false);
    expect(budget.admit(1)).toBe(false);
    expect(budget.exceeded).toBe(true);
  });

  it("refuses many small entries whose sum passes the cap, not just one big one", () => {
    const budget = makeSizeBudget(100);
    // Ten entries of 11 bytes: each is tiny, the ninth is where the sum bites.
    const admitted = Array.from({ length: 10 }, () => budget.admit(11)).filter(Boolean).length;
    expect(admitted).toBe(9);
    expect(budget.exceeded).toBe(true);
  });

  it("a deck within the cap decompresses normally", async () => {
    const slide = (t: string) => `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="x"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const out = await extract("Small.pptx", zip({ "ppt/slides/slide1.xml": slide("Only") }));
    expect(out).toMatchObject({ kind: "extracted", type: "slides" });
  });
});

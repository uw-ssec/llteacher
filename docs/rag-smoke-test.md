# RAG smoke test (run before each release this quarter)

Environment: staging, one instructor account, one student account in the same course.

## Instructor loop
1. Knowledge → Upload folder → pick the Econ 201 export. Expect every file listed under Materials with its folder path.
2. After extraction completes: `.txt` captions, `.docx`, `.pptx`, and text-layer PDFs show `ready`; scanned PDFs show `pending` with a reason. MP3s, extensionless files, and files over 25 MB are rejected. Record counts and elapsed time.
3. Open a `ready` material's document. Body is readable markdown; frontmatter shows `resource` and `status: generated`.
4. Search box: type a phrase from a lecture. The lecture is in the results. Type nonsense. "No documents matched".
5. Edit a document body and save. Search for a word you added. It is found.
6. Delete a material. Its document disappears from the tree and from search.

## Student loop
7. Open a section conversation. Ask five direct questions answered by uploaded material, then five paraphrased ones
   ("why would a price ceiling cause a shortage" when the slide says "binding price ceiling leads to excess demand").
8. For each, record: did the tutor call searchKnowledge (visible in the server log as a tool part), did the answer use the
   material, did Sources render with the right document. Target: 9 of 10 grounded.
9. Ask about a topic not in the material. The tutor says it found nothing in the course knowledge base.
10. Reload the conversation. Sources still render on the persisted messages.

## Isolation
11. Log in as a student of a second course with different material. Ask about the first course's lecture. Nothing is found.

## Conformance
12. On the task (or a copy of the EFS directory): `okf validate /mnt/knowledge/courses/<courseId>/knowledge --strict --drift`.
    Expect `is_conformant: true`; broken links are allowed to appear but must match what the console's links panel shows.

## Record
Paste the counts from step 2 and the 10-row table from step 8 into the release PR.

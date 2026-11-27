# Persistent photo similarity

The app automatically builds a local MobileNet scene fingerprint for every photo while the archive is open, including photos without dates or locations. Jobs shows saved progress, Pause/Resume, and Retry for failures. Closing the app stops work; reopening resumes missing or outdated entries.

Fingerprints are stored as `Photo.similarityIndex` in the selected archive storage: IndexedDB, the folder's `ancestry_db.json`, or the configured Firebase project. Processing uses the original image on this device. Cloud storage also stores the fingerprint as archive metadata; no external inference service is used.

Each index records the model ID, preprocessing version, original revision, and descriptor. New originals get a stable revision; legacy records use `legacy-v1`. Replacing an original creates a new revision and removes its old index. Description, people, date, location, restored preview, and thumbnail changes do not invalidate the scene fingerprint. Original files changed outside the app are not detected by this revision scheme.

The scene worker consistently decodes the original and resizes its longest edge to at most 640 pixels. A shared scheduler allows one face or scene inference at a time. The similarity queue keeps its worker alive for a batch, prioritizes the opened photo, skips failed originals until Retry, and rejects results after archive switches, deletion, or replacement. Saved index patches preserve concurrent metadata edits.

The editor ranks available saved fingerprints automatically, using current date/location metadata as references. It can show partial results while the catalogue fills. Explicit scene comparisons reuse valid fingerprints and compute missing ones on request. They remain independent of background index arrivals. Manual mode (the default) applies suggested metadata only after the user accepts it. The optional Automatic on new uploads setting fills empty dates and locations on new imports after reference indexing finishes, skipping ambiguous matches. These values remain visibly marked as AI suggestions until confirmed or edited. Unconfirmed AI values are excluded from reference evidence, so guesses cannot propagate through the archive. Existing archive photos are not opted in when the setting changes.

Folder persistence uses the existing atomic JSON write queue, with one commit per completed fingerprint. The catalogue enlarges the archive metadata file; very large archives may benefit from separate index storage or batched commits in a future version.

Focused regression files: `background-photo-similarity.spec.mjs`, `similarity-index-storage.spec.mjs`, and `similarity-index-engine.spec.mjs`, and `automatic-photo-suggestions.spec.mjs`. Ordinary tests pause both automatic queues through Playwright storage state; dedicated queue tests explicitly enable the relevant job.

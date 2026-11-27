# Local SFace face recognition

Recognition runs on the user's device in a Web Worker using ONNX Runtime Web's single-threaded WASM CPU backend. Model/runtime requests go to this app's own asset origin. The recognizer does not send photos or embeddings to an external recognition service. Archive storage selection still controls whether saved photo metadata goes to browser, filesystem or Firebase storage.

## Model files and commercial distribution

Models come from OpenCV Zoo commit `48b10fa505aeb51fbd127fc60a5c660040e823b7`:

- `face_recognition_sface_2021dec.onnx`: SHA-256 `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79`; Apache 2.0, as published in that model directory.
- `face_detection_yunet_2023mar.onnx`: SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`; MIT, as published in that model directory.
- ONNX Runtime Web 1.31.1: MIT.

`public/face-recognition/` contains the model license texts and `NOTICE.txt`. Retain them when redistributing. The Vite public directory copies these files into production builds. `scripts/prepare-face-recognition.mjs` restores missing pinned models/notices, verifies hashes, and copies the installed runtime's WASM files. Once assets are present the script needs no network access.

The published SFace model license permits commercial use. This is not a guarantee that training-data rights have been comprehensively cleared. OpenCV Zoo issue [318](https://github.com/opencv/opencv_zoo/issues/318) records outstanding provenance questions and a maintainer's response pointing to Apache 2.0. Do not describe the model as unconditionally cleared of all third-party rights. No InsightFace pretrained weights are used.

## Inference details

`createFaceRecognizer()` reuses a worker/model session across sequential `recognize(source, { signal, onProgress })` calls. Dispose it after a scan. `recognizeFaces()` is a one-image convenience wrapper. Aborting a call terminates and disposes that session. Inactivity does not keep the models alive after disposal.

- YuNet detects boxes and five actual landmarks (eyes, nose and mouth corners), using 640 x 640 padded BGR inputs with raw 0..255 floats and score threshold 0.75. Large photographs also get four overlapping crop passes for smaller group-photo faces. Overlapping boxes are suppressed by IoU 0.3.
- A least-squares similarity transform aligns the five landmarks to SFace's canonical 112 x 112 template.
- SFace uses raw RGB float input (NCHW); the model itself handles normalization. Its 128-value feature output is L2 normalized before matching/storage.
- Box coordinates are percentages of the original image. Faces smaller than 20 source pixels are ignored for recognition. This threshold does not claim quality sufficient for reliable identification.
- `SFACE_MODEL_ID` includes the weights and preprocessing revision; incompatible old embeddings must be recomputed.

Algorithm references: [OpenCV FaceRecognizerSF](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_recognize.cpp), [OpenCV FaceDetectorYN](https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/face_detect.cpp). This implementation independently implements their documented model preprocessing and output decoding.

Similarity scores are not probabilities of identity. Thresholds require testing on representative scans, including unrelated people and similar relatives. Suggestions must be confirmed by the user before becoming reference samples. Recognition should use original scans, because generative restoration can change identifying detail.

## Using recognition

1. Open or reconnect the archive. Unscanned photos are processed automatically in the background, including unnamed photos and new imports. Compatible saved signatures are reused after reopening the app.
2. Open a photo in Enhance / Edit. Its suggestions appear as soon as its scan and named reference samples are available. Confirm a suggested name or click a face to choose another name. Uncertain matches remain unnamed.
3. Confirming or correcting a spatial tag updates suggestions for other already scanned photos without rerunning the image model. Only confirmed spatial tags become reference examples; photo-level People entries alone are insufficient.
4. Use **Pause recognition** / **Resume recognition** in the archive progress strip or the editor. Pause is remembered on this browser/device. **Retry failed photos** retries failures while respecting Pause.
5. Choose **Clear saved face signatures from this archive** to cancel scanning, pause automatic processing, and remove computed data while preserving confirmed names/tags. Resume explicitly to rebuild. Replacing an original invalidates only its computed data and automatically queues the replacement when recognition is active.

## Background queue

`hooks/useBackgroundFaceRecognition.ts` owns one serial queue for the open archive, independent of photo dialogs. It processes the currently viewed photo next, then tagged reference photos, then remaining originals. It yields between jobs and reuses a worker/model session until the queue is idle. Closing the editor does not stop it. Closing the browser/app does stop processing; on reopening, saved signatures identify completed jobs and remaining jobs resume unless paused.

Loading an archive, opening Settings, and importing suspend model work. Archive generation and original-image checks prevent stale results from being committed to a different archive or replacement. Index saves patch recognition metadata only; loading and writes share a queue so edits are preserved. Individual failures are skipped without blocking other photos and can be retried explicitly. Progress counts reflect valid saved indices; a completed blank-photo scan is cached too.

Signatures are stored as `Photo.faceRecognition` in the selected archive backend (IndexedDB, folder JSON, or Firebase). Choosing cloud storage saves this biometric metadata there; recognition itself makes no external inference request. Stable `FaceTag.personId` links are saved when a matching family-tree person exists; legacy name-only tags remain supported. Current-photo samples are excluded when proposing identities for that same photo. Scan failures leave manual tagging available.

Default cosine similarity and runner-up margin are 0.55 and 0.08. These are starting values, not measured accuracy guarantees. Automatically applied names remain tentative and must be confirmed before they can enroll as reference samples.

Ordinary Playwright regressions start with recognition paused to isolate existing behaviors; dedicated background-recognition tests enable and exercise automatic processing.

## Optional automatic application on upload

Settings > General offers Manual (the default) or Automatic on new uploads. Automatic mode marks only newly uploaded photos for application after the existing background jobs prepare their indices. It fills unassigned recognized faces and empty dates/locations from supported archive matches. Imported TIFF dates and existing values are preserved. Switching the setting does not enroll older archive photos for automatic application, and pausing background jobs is respected.

Automatically assigned face tags carry `aiSuggested: true`; dates and locations store their suggested value and source photo IDs in `aiMetadata`. The gallery, viewer, and editor distinguish these values with violet AI labels. Confirming a value removes its tentative marker; editing or removing it also cancels the associated pending application. Unconfirmed AI tags and metadata cannot supply evidence for further suggestions. Recognition remains local; ordinary archive storage still determines where the saved results live.

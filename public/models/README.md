# Modèle de détection de visages

`blaze_face_full_range.tflite` — MediaPipe Face Detector (BlazeFace, « full range »), Google,
licence Apache-2.0. Téléchargé depuis
`https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/`
par `.github/workflows/fetch-models.yml` ; empreinte dans `SHA256SUMS`, vérifiée par l'application
avant usage (`src/lib/media/face-tracker.ts`). Chargé uniquement quand on active « Visages floutés ».

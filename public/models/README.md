# Modèles embarqués

| Fichier | Origine | Licence | SHA-256 |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | [OpenCV Zoo — YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (232 589 octets) | MIT | voir `SHA256SUMS` |

L'empreinte est vérifiée par le worker avant chaque chargement (`src/lib/media/face-tracker.ts`) :
un fichier altéré est refusé (et l'image entière est alors pixelisée, échec fermé).

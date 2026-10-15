# 文字辨識模型（PP-OCRv5 行動版）

- `det.ort`：文字位置偵測（PP-OCRv5_mobile_det，ORT 格式）
- `rec.onnx`：文字辨識（PP-OCRv5_mobile_rec，多語言：繁中、簡中、英文、日文）。為了縮小下載量，只把 MatMul 權重量化成 8 位元（約 16.6MB → 9.2MB），測試的辨識結果和原版相同。
- `dict.txt`：辨識用的字典（已移除原檔中的空白行）

模型來自 [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)，ONNX 轉檔來自 [ppu-paddle-ocr-models](https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models)，皆為 Apache-2.0 授權，見 `LICENSE`。

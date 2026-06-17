#!/usr/bin/env python3
"""
Download jina-embeddings-v5-text-nano-retrieval ONNX model to local directory.

Usage:
    python3 scripts/download-jina-model.py

The model will be saved to models/jina-nano/ relative to the plugin directory.
Uses the quantized ONNX variant (~247 MB).
"""

import os
import sys

try:
    from huggingface_hub import snapshot_download
except ImportError:
    print("huggingface_hub not installed. Installing...")
    os.system(f"{sys.executable} -m pip install huggingface_hub")
    from huggingface_hub import snapshot_download

MODEL_ID = "jinaai/jina-embeddings-v5-text-nano-retrieval"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR = os.path.join(PLUGIN_DIR, "models", "jina-nano")

ALLOW_PATTERNS = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model_quantized.onnx",
    "onnx/model_quantized.onnx_data",
]

def main():
    print(f"Downloading {MODEL_ID} to {OUTPUT_DIR}")
    print(f"Files: {ALLOW_PATTERNS}")
    print()

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=OUTPUT_DIR,
        allow_patterns=ALLOW_PATTERNS,
    )

    config_path = os.path.join(OUTPUT_DIR, "config.json")
    if os.path.exists(config_path):
        print(f"\nModel downloaded successfully to {OUTPUT_DIR}")
        size_mb = sum(
            os.path.getsize(os.path.join(dp, f))
            for dp, _, filenames in os.walk(OUTPUT_DIR)
            for f in filenames
        ) / (1024 * 1024)
        print(f"Total size: {size_mb:.1f} MB")
    else:
        print("ERROR: config.json not found after download", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

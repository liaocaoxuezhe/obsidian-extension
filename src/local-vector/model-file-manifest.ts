/**
 * Pinned model files for every selectable embedding model (generated from the
 * Hugging Face API on 2026-10-13). Each file is verified by size and SHA-256 after
 * download, so any mirror serving identical bytes is trusted equally.
 */
export interface ModelFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ModelFileManifest {
  /** Hugging Face repository id, also the directory inside the model cache. */
  id: string;
  /** Commit the files are pinned to. */
  revision: string;
  files: readonly ModelFileEntry[];
}

export const MODEL_FILE_MANIFESTS: Readonly<Record<string, ModelFileManifest>> = {
  "bge-small-en-v1.5": {
    id: "Xenova/bge-small-en-v1.5",
    revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
    files: [
      { path: "config.json", size: 683, sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350" },
      { path: "tokenizer.json", size: 711396, sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
      { path: "tokenizer_config.json", size: 366, sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3" },
      { path: "onnx/model_quantized.onnx", size: 34014426, sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4" },
    ],
  },
  "all-MiniLM-L6-v2": {
    id: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    files: [
      { path: "config.json", size: 650, sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7" },
      { path: "tokenizer.json", size: 711661, sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0" },
      { path: "tokenizer_config.json", size: 366, sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3" },
      { path: "onnx/model_quantized.onnx", size: 22972370, sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1" },
    ],
  },
  "bge-small-zh": {
    id: "Xenova/bge-small-zh-v1.5",
    revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
    files: [
      { path: "config.json", size: 716, sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f" },
      { path: "tokenizer.json", size: 439125, sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26" },
      { path: "tokenizer_config.json", size: 367, sha256: "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a" },
      { path: "onnx/model_quantized.onnx", size: 24010842, sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc" },
    ],
  },
  "embedding-gemma-300m": {
    id: "onnx-community/embeddinggemma-300m-ONNX",
    revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
    files: [
      { path: "config.json", size: 1765, sha256: "6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b" },
      { path: "tokenizer.json", size: 20323312, sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47" },
      { path: "tokenizer_config.json", size: 1156830, sha256: "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a" },
      { path: "onnx/model_quantized.onnx", size: 567874, sha256: "172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8" },
      { path: "onnx/model_quantized.onnx_data", size: 308890624, sha256: "705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0" },
    ],
  },
  "jina-nano": {
    id: "jinaai/jina-embeddings-v5-text-nano-retrieval",
    revision: "ac5d898c8d382b17167c33e5c8af644a3519b47d",
    files: [
      { path: "config.json", size: 1361, sha256: "367857e3a726df6f1997bcb8443a4351e68b29c65f996e5874a4b3e7c5661a16" },
      { path: "tokenizer.json", size: 17210235, sha256: "98d4a1d32152d6cedf85b5e88f3b205106dca1fe72aaab34e0ac13c238421069" },
      { path: "tokenizer_config.json", size: 487, sha256: "6c4640d432db970b2436a4386d3ee992b99e756b62c37446c3f581c8d09cbb05" },
      { path: "onnx/model_quantized.onnx", size: 131365, sha256: "ac93a7417c216e5076e37da2b3599f7ef16513934098a477680440c09f735a08" },
      { path: "onnx/model_quantized.onnx_data", size: 247006208, sha256: "ee7870eb143a7353be08b33f79992a51de3e32b41f684ccd82953a710c2f2f9c" },
    ],
  },
  "granite-97m-multilingual-r2": {
    id: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    revision: "536a9f241cb3f02a9c5995a1e708c784bd274859",
    files: [
      { path: "config.json", size: 1215, sha256: "ae74d55a56f779774cb9a8e63d3c2da9ae1af83c00229ffdff43d0b38407a0ee" },
      { path: "tokenizer.json", size: 25301671, sha256: "51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a" },
      { path: "tokenizer_config.json", size: 12860, sha256: "6ed69389e30a8ecabfce2f9ebcdf0c908b34056f24d994340f2f216521c057d5" },
      { path: "onnx/model_quantized.onnx", size: 97858099, sha256: "704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22" },
    ],
  },
  "granite-small-english-r2": {
    id: "onnx-community/granite-embedding-small-english-r2-ONNX",
    revision: "1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8",
    files: [
      { path: "config.json", size: 1526, sha256: "1a1710c20911da8c96179716bf44058e54cca6fa7952cce77be83ef05edae3ee" },
      { path: "tokenizer.json", size: 2128614, sha256: "feeb83348dcb033bc6b9d2e1f7906ca9eb2d122845000c9416d894d7c2927149" },
      { path: "tokenizer_config.json", size: 20839, sha256: "ce06781b38bb393db68c9e0709bddd31ef5d88f2c6fbb3fd9f369778fb85e451" },
      { path: "onnx/model_quantized.onnx", size: 598902, sha256: "a3fad524afc3f060216a8ddbb1ac89c9b6498fba8995b5718bde879076a2e9ba" },
      { path: "onnx/model_quantized.onnx_data", size: 51885568, sha256: "1f4cf47e4adec7f7ae09db03d071ba8667e07f9a4203142c7efa8d37fe453597" },
    ],
  },
};

const fs = require("fs");
const os = require("os");
const path = require("path");

const TOPICS = [
  "machine learning", "deep learning", "neural networks", "natural language processing",
  "computer vision", "reinforcement learning", "generative AI", "large language models",
  "transformer architecture", "attention mechanism", "BERT", "GPT", "semantic search",
  "vector database", "embedding models", "knowledge graph", "information retrieval",
];

function createSemanticWalkVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "analogy-semantic-walk-vault-"));
  for (let index = 0; index < 100; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    const fileName = `note_${String(index + 1).padStart(3, "0")}_${topic.replace(/\s+/g, "_")}.md`;
    fs.writeFileSync(
      path.join(root, fileName),
      `# ${topic}\n\n${topic} connects local notes through deterministic semantic relationships.\n\n## Details\n\nFixture ${index + 1} preserves UTF-8 text: 知识管理与关联发现。\n`,
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(root, "note_101_semantic_walk_中文多级主题.md"),
    "# 语义探索\n\n从本地笔记开始探索。\n\n## 关联漫游\n\n沿着语义关系逐步展开。\n\n### 多级主题\n\n保持稳定的中文 UTF-8 测试内容。\n\n## 第二分支\n\n用于测试多分支。\n\n### 细节一\n\n测试内容。\n\n### 细节二\n\n测试内容。\n\n## 第三分支\n\n测试内容。\n\n### 结束\n\n测试内容。\n",
    "utf8",
  );
  return root;
}

module.exports = { createSemanticWalkVault };

const fs = require("fs");
const path = require("path");

const roots = [path.resolve(__dirname, "..")];

const failures = [];

for (const root of roots) {
  const file = path.join(root, "src/SmartConnection.tsx");
  const text = fs.readFileSync(file, "utf8");

  if (/\.style\.height\b/.test(text)) {
    failures.push(`${file} assigns height through HTMLElement.style`);
  }

  if (!/\.setCssProps\s*\(/.test(text)) {
    failures.push(`${file} does not use setCssProps for textarea height`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

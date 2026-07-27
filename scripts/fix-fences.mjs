import fs from "fs";
const filePath = new URL("../docs/api_endpoints.md", import.meta.url);
const content = fs.readFileSync(filePath, "utf8");
const before = (content.match(/^```$/gm) || []).length;
const fixed = content.replace(/```\n\n(#### |### )/g, "$1");
const after = (fixed.match(/^```$/gm) || []).length;
fs.writeFileSync(filePath, fixed, "utf8");
console.log(`Fixed: removed ${before - after} stray code fences (${before} -> ${after} total)`);

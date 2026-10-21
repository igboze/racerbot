import fs from 'fs';
import ts from 'typescript';

const txt = fs.readFileSync('packages/api/src/raceralpha.html', 'utf8');
const start = txt.indexOf('<script>') + 8;
const end = txt.indexOf('</script>', start);
const js = txt.substring(start, end);

const lines = js.split('\n');

// Find brace balance
let depth = 0;
const stack = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Simple scan ignoring strings
  let inStr = false;
  let strChar = '';
  for (let c = 0; c < line.length; c++) {
    const ch = line[c];
    if (inStr) {
      if (ch === strChar && line[c - 1] !== '\\') {
        inStr = false;
      }
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = true;
        strChar = ch;
      } else if (ch === '{') {
        depth++;
        stack.push({ line: i + 1, htmlLine: 2875 + i + 1, content: line.trim() });
      } else if (ch === '}') {
        depth--;
        stack.pop();
      }
    }
  }
}

console.log('Final depth:', depth);
console.log('Unclosed blocks:', stack.slice(-5));

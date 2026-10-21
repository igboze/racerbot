import fs from 'fs';
import ts from 'typescript';

const txt = fs.readFileSync('packages/api/src/raceralpha.html', 'utf8');
const start = txt.indexOf('<script>') + 8;
const end = txt.indexOf('</script>', start);
const js = txt.substring(start, end);

const sourceFile = ts.createSourceFile(
  'raceralpha.inline.js',
  js,
  ts.ScriptTarget.Latest,
  true
);

const diagnostics = sourceFile.parseDiagnostics || [];
console.log('Total parse diagnostics:', diagnostics.length);

for (const d of diagnostics) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start);
  console.log(`Diagnostic: ${d.messageText}`);
  console.log(`Inline line: ${line + 1}, char: ${character + 1}`);
  console.log(`HTML file line: ${2875 + line + 1}`);
  
  const lines = js.split('\n');
  console.log('Context:');
  for (let i = Math.max(0, line - 3); i <= Math.min(lines.length - 1, line + 3); i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
  console.log('---');
}

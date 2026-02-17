const fs = require('fs');
const filePath = './server.js';
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');
console.log('Total lines before:', lines.length);

// Keep lines 1-854 (index 0-853) and lines 1140+ (index 1139+)
const before = lines.slice(0, 854);
const after = lines.slice(1139);
const result = before.concat(after);
fs.writeFileSync(filePath, result.join('\n'));
console.log('Total lines after:', result.length);
console.log('Removed', lines.length - result.length, 'lines');

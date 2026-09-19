const fs = require('fs');
const path = require('path');

const replacements = {
  'bg-paper': 'bg-white',
  'border-rule': 'border-line',
  'divide-rule': 'divide-line',
  'bg-stone-50': 'bg-surface',
  'bg-stone-100': 'bg-surface',
  'text-stone-400': 'text-muted',
  'text-stone-500': 'text-muted',
  'text-stone-600': 'text-muted',
  'text-stone-900': 'text-ink',
  'bg-stone-900': 'bg-ink',
  'bg-zinc-900': 'bg-ink'
};

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      if (!file.includes('node_modules') && !file.includes('.next')) {
        results = results.concat(walk(file));
      }
    } else {
      if (file.endsWith('.tsx') || file.endsWith('.ts')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = [...walk('./web/app'), ...walk('./web/components')];

let updatedFilesCount = 0;

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let newContent = content;
  
  for (const [oldClass, newClass] of Object.entries(replacements)) {
    // Replace with word boundaries to avoid matching partial classes
    const regex = new RegExp(`\\b${oldClass}\\b`, 'g');
    newContent = newContent.replace(regex, newClass);
  }
  
  if (content !== newContent) {
    fs.writeFileSync(file, newContent, 'utf8');
    updatedFilesCount++;
    console.log(`Updated ${file}`);
  }
});

console.log(`Successfully updated ${updatedFilesCount} files.`);

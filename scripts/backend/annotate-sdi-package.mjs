import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

async function annotate(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await annotate(file);
    else if (entry.name.endsWith('.js')) {
      const source = await readFile(file, 'utf8');
      const marker = `// @ts-self-types="./${basename(file, '.js')}.d.ts"\n`;
      await writeFile(file, source.startsWith('#!') ? source.replace('\n', `\n${marker}`) : marker + source);
    }
  }
}

await annotate(resolve(process.cwd(), 'dist'));

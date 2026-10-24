import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tokenIconsMap: Record<string, string> = {};

const possiblePaths = [
  path.resolve(__dirname, 'authenticIcons.json'),
  path.resolve(__dirname, '..', 'src', 'authenticIcons.json'),
  path.resolve(process.cwd(), 'packages', 'api', 'src', 'authenticIcons.json'),
  path.resolve(process.cwd(), 'packages', 'api', 'dist', 'authenticIcons.json'),
  path.resolve(process.cwd(), 'scratch', 'authentic_icons.json'),
];

for (const p of possiblePaths) {
  try {
    if (fs.existsSync(p)) {
      tokenIconsMap = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Object.keys(tokenIconsMap).length > 0) break;
    }
  } catch {}
}

export function getAuthenticTokenIcon(tokenAddress: string): string | undefined {
  if (!tokenAddress) return undefined;
  const lower = tokenAddress.toLowerCase().trim();
  return tokenIconsMap[lower] || undefined;
}

export const AUTHENTIC_TOKEN_ICONS = tokenIconsMap;

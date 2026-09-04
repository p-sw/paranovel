import { config } from 'dotenv';
import { resolve } from 'node:path';

// npm runs workspace scripts with the package directory as cwd. Load both a
// package-local override and the repository-level file documented for local dev.
config({
  path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../..', '.env')],
  override: false,
  quiet: true,
});

import { join } from 'node:path';
import { build } from 'tsdown';
import { WIDGET_FILE, widgetConfig } from './tsdown.widget.ts';

/** Builds the script into `outDir` (tests: a temp directory of their own, never the shared `dist-widget/`). */
export async function buildWidget(outDir: string): Promise<string> {
  await build({ ...widgetConfig, config: false, cwd: import.meta.dirname, outDir, clean: false, logLevel: 'silent' });
  return join(outDir, WIDGET_FILE);
}

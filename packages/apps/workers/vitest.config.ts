import * as path from 'node:path';
import { createVitestConfig } from '../../../vitest.config.shared.js';

export default createVitestConfig({
    root: import.meta.dirname,
    workspaceDepsRoot: path.resolve(import.meta.dirname, '../../lib'),
    workspaceDeps: ['core', 'config', 'telegram', 'agent', 'sandbox', 'plugins', 'i18n', 'ai', 'types'],
});

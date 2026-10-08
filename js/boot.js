import { startApp } from './boot-core.js';
void startApp({ load: () => import('./app.js'), doc: document, reload: () => location.reload() });
